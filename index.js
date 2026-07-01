const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const instances = new Map();

// MEMORIA TEMPORAL AUTOLIMPIABLE: Almacena "telefono" => "codigo" para el bypass interactivo
const pendingOtps = new Map();

// Helper para pausar la ejecución de forma limpia
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function initInstance(instanceId) {
    if (instances.has(instanceId)) {
        console.log(`[${instanceId}] La instancia ya se encuentra activa en memoria.`);
        return;
    }

    const sessionPath = path.join(__dirname, 'sessions', instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        shouldSyncHistoryMessage: () => false // Evita procesar historial masivo antiguo al conectar
    });

    instances.set(instanceId, { sock, qr: null, status: 'INITIALIZING' });

    sock.ev.on('creds.update', saveCreds);

    // =======================================================================
    // LISTENER EN VIVO: Captura el clic de contingencia ("Click-to-Chat")
    // =======================================================================
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // Saltamos si el mensaje es nuestro (enviado por el bot) o si proviene de un grupo
            if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

            const incomingText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const cleanText = incomingText.trim().toLowerCase();

            // Detecta la palabra clave exacta configurada en tu Frontend vía wa.me
            if (cleanText.includes('solicito mi codigo otp') || cleanText.includes('solicito mi código otp')) {
                const targetJid = msg.key.remoteJid;
                const phoneWithoutJid = targetJid.split('@')[0]; // Extrae el número limpio (Ej: 51961762940)

                console.log(`[${instanceId}] Solicitud entrante de bypass detectada para el teléfono: ${phoneWithoutJid}`);

                // Buscamos si existe un código vigente en nuestra memoria volátil
                const activeCode = pendingOtps.get(phoneWithoutJid);
                let messageToReply = '';

                if (activeCode) {
                    // SI EXISTE: Reenviamos exactamente el mismo string del hash de Spring Boot
                    messageToReply = `Tu código de verificación solicitado es: *${activeCode}*.\nIntrodúcelo en la casilla de tu pantalla actual.`;
                } else {
                    // SI YA EXPIRÓ (Pasaron los 5 minutos): Avisamos al cliente de manera clara
                    messageToReply = `No encontramos ninguna solicitud de código activa o tu token ya expiró por seguridad. Por favor, vuelve a intentarlo desde la web.`;
                }

                try {
                    // Simulación humana nativa en el chat abierto
                    await sock.sendPresenceUpdate('composing', targetJid);
                    await delay(1500);
                    await sock.sendPresenceUpdate('paused', targetJid);

                    await sock.sendMessage(targetJid, { text: messageToReply });
                    console.log(`[${instanceId}] Contingencia respondida con éxito a: ${phoneWithoutJid}`);
                } catch (err) {
                    console.error(`[${instanceId}] Error enviando respuesta en el Listener de contingencia:`, err);
                }
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const currentInstance = instances.get(instanceId);

        if (qr) {
            const qrBase64 = await QRCode.toDataURL(qr);
            if (currentInstance) {
                currentInstance.qr = qrBase64;
                currentInstance.status = 'PENDING_SCAN';
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[${instanceId}] Conexión cerrada. Razón/Status: ${statusCode}. ¿Reconectando?: ${shouldReconnect}`);
            
            instances.delete(instanceId);

            if (shouldReconnect) {
                console.log(`[${instanceId}] Esperando 5 segundos antes de reintentar reconexión para mitigar saturación...`);
                setTimeout(() => {
                    initInstance(instanceId); 
                }, 5000);
            } else {
                console.log(`[${instanceId}] Sesión destruida por el usuario o desvinculada.`);
                fs.rmSync(sessionPath, { recursive: true, force: true }); 
            }
        } else if (connection === 'open') {
            console.log(`🚀 [${instanceId}] ¡WhatsApp conectado y listo!`);
            if (currentInstance) {
                currentInstance.qr = null;
                currentInstance.status = 'CONNECTED';
            }
        }
    });
}

// 1. Crear / Inicializar una instancia
app.post('/instance/init', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Falta el parámetro instanceId' });

    await initInstance(instanceId);
    return res.status(200).json({ message: `Inicializando instancia: ${instanceId}` });
});

// 2. Obtener el estado y el código QR de una instancia
app.get('/instance/qr/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const instance = instances.get(instanceId);

    if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });

    return res.status(200).json({
        instanceId,
        status: instance.status,
        qr: instance.qr 
    });
});

// 3. Enviar OTP seleccionando la instancia (CON ANCLAJE DE MEMORIA Y AUTO-REINTENTO)
// 3. Enviar OTP seleccionando la instancia (CON ANCLAJE DE MEMORIA Y AUTO-REINTENTO CORREGIDO)
app.post('/instance/send-otp', async (req, res) => {
    const { instanceId, phone, code, message } = req.body;

    if (!instanceId || !phone || !code) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios: instanceId, phone o code' });
    }

    const instance = instances.get(instanceId);
    if (!instance || instance.status !== 'CONNECTED') {
        return res.status(400).json({ error: `La instancia [${instanceId}] no está conectada o lista.` });
    }

    const cleanedPhone = phone.trim();

    // =======================================================================
    // REGISTRO DE SEGURIDAD EN MEMORIA: Evita la persistencia infinita en RAM
    // =======================================================================
    pendingOtps.set(cleanedPhone, code);
    
    // El registro vive estrictamente 5 minutos (300000 ms) y luego se limpia solo
    setTimeout(() => {
        if (pendingOtps.get(cleanedPhone) === code) {
            pendingOtps.delete(cleanedPhone);
            console.log(`[Memory Garbage Collector] Código expirado y limpiado para el número: ${cleanedPhone}`);
        }
    }, 5 * 60 * 1000);

    const maxAttempts = 2;
    let attempt = 0;

    while (attempt < maxAttempts) {
        try {
            attempt++;
            let targetJid = `${cleanedPhone}@s.whatsapp.net`;

            const [result] = await instance.sock.onWhatsApp(cleanedPhone);
            
            if (!result || !result.exists) {
                return res.status(404).json({ error: `El número ${cleanedPhone} no está registrado en WhatsApp.` });
            }
            
            targetJid = result.jid;

            await instance.sock.sendPresenceUpdate('composing', targetJid);
            await delay(attempt === 1 ? 2000 : 5000); 
            await instance.sock.sendPresenceUpdate('paused', targetJid);

            // Prioriza usar la plantilla estructurada que viene desde tu Spring Boot (message)
            const finalMessage = message || `Tu código de verificación es: *${code}*.\nExpirará en 5 minutos.`;

            await instance.sock.sendMessage(targetJid, { text: finalMessage });
            
            // Si el mensaje se envía con éxito, retornamos isRestricted: false
            return res.status(200).json({ 
                success: true, 
                isRestricted: false, 
                message: 'OTP enviado con éxito por vía directa' 
            });
            
        } catch (error) {
            console.error(`[${instanceId}] Error en intento ${attempt} al enviar OTP:`, error);

            const errorMessage = error.message || '';
            const rawErrorData = error.jsonData || JSON.stringify(error);
            
            // Detección estricta del error 463 de Meta
            const isRestricted = errorMessage.includes('463') || rawErrorData.includes('463') || errorMessage.includes('restricted');

            if (isRestricted) {
                if (attempt < maxAttempts) {
                    console.warn(`[${instanceId}] Detectado error 463 en intento ${attempt}. Esperando 3 segundos antes del reintento...`);
                    await delay(3000);
                    continue; // Ejecuta el intento 2
                } else {
                    // 🚨 AQUÍ ESTÁ EL CAMBIO CLAVE: Si ya agotó los intentos y sigue dando 463, 
                    // devolvemos un HTTP 200 con isRestricted: true. De esta manera, Spring Boot 
                    // sabrá que no es un error del servidor, sino un bypass controlado que debe dejar pasar.
                    console.warn(`[${instanceId}] Error 463 persistente tras ${attempt} intentos. Activando bypass de contingencia.`);
                    return res.status(200).json({ 
                        success: true, 
                        isRestricted: true, 
                        message: 'Bypass de contingencia activado por restricciones del canal directo (Meta Error 463).' 
                    });
                }
            }

            // Si es cualquier otro error que no sea el 463 (ej. caída de red), devolvemos HTTP 500
            return res.status(500).json({ 
                error: 'Error al enviar el mensaje de verificación', 
                details: errorMessage,
                isRestricted: false 
            });
        }
    }
});

// 4. Enviar Mensaje Genérico (Flujos)
app.post('/instance/send-message', async (req, res) => {
    const { instanceId, phone, message } = req.body;

    if (!instanceId || !phone || !message) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios: instanceId, phone o message' });
    }

    const instance = instances.get(instanceId);
    if (!instance || instance.status !== 'CONNECTED') {
        return res.status(400).json({ error: `La instancia [${instanceId}] no está conectada o lista.` });
    }

    try {
        const cleanedPhone = phone.trim();
        let targetJid = `${cleanedPhone}@s.whatsapp.net`;

        const [result] = await instance.sock.onWhatsApp(cleanedPhone);
        if (result && result.exists) {
            targetJid = result.jid;
        }

        await instance.sock.sendPresenceUpdate('composing', targetJid);
        await delay(1500);
        await instance.sock.sendPresenceUpdate('paused', targetJid);

        await instance.sock.sendMessage(targetJid, { text: message });
        
        return res.status(200).json({ success: true, message: 'Mensaje de flujo enviado con éxito' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al enviar el mensaje de flujo', details: error.message });
    }
});

// 5. Servidor en escucha y auto-restauración al iniciar
const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', () => { 
    console.log(`API Multi-Instancia corriendo de forma segura en el puerto: ${PORT}`);
    
    const sessionsDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        fs.readdirSync(sessionsDir).forEach(file => {
            if (fs.statSync(path.join(sessionsDir, file)).isDirectory()) {
                console.log(`Restaurando sesión guardada de: ${file}`);
                initInstance(file);
            }
        });
    }
});