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

// Monitoreo proactivo de ráfagas de error 463
let lastRestrictionDetectedAt = 0;

// Helper para pausar la ejecución de forma limpia
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper para esperar a ver si el mensaje enviado reporta un fallo de restricción/error de forma síncrona
function waitForMessageStatus(sock, msgId, timeoutMs = 2500) {
    return new Promise((resolve) => {
        let isResolved = false;

        const cleanUp = () => {
            isResolved = true;
            sock.ev.off('messages.update', updateListener);
        };

        const updateListener = (updates) => {
            if (isResolved) return;
            for (const update of updates) {
                // Si la actualización corresponde a nuestro mensaje enviado
                if (update.key && update.key.id === msgId) {
                    // Evaluamos si Meta le asignó un estado de error
                    const status = update.update?.status;
                    // En Baileys, status 0 o valores de error/jsonData con 463 indican fallo
                    if (status === 0 || JSON.stringify(update).includes('463')) {
                        cleanUp();
                        resolve({ failed: true, isRestricted: true });
                        return;
                    }
                }
            }
        };

        // Escuchamos activamente las actualizaciones de estados de mensajes
        sock.ev.on('messages.update', updateListener);

        // Si pasan 2.5 segundos y no se reportó ningún error crítico, asumimos que fluyó bien
        setTimeout(() => {
            if (!isResolved) {
                cleanUp();
                resolve({ failed: false, isRestricted: false });
            }
        }, timeoutMs);
    });
}

async function initInstance(instanceId) {
    if (instances.has(instanceId)) {
        console.log(`[${instanceId}] La instancia ya se encuentra activa en memoria.`);
        return;
    }

const sessionPath = path.join(__dirname, 'sessions', instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const P = require('pino');
    const customLogger = P({ level: 'info' }, P.destination({
        write(msg) {
            // Mantenemos la salida en los logs de Render
            process.stdout.write(msg);

            // Si el log contiene la restricción 463, guardamos el milisegundo exacto del fallo
            if (msg.includes('error 463') || msg.includes('restricted')) {
                console.warn(`[⚠️ Alerta Global] Error 463 detectado en los flujos de red de Meta. Registrando marca de restricción.`);
                lastRestrictionDetectedAt = Date.now();
            }
        }
    }));

    const sock = makeWASocket({
        auth: state,
        logger: customLogger,
        printQRInTerminal: true,
        shouldSyncHistoryMessage: () => false
    });

    instances.set(instanceId, { sock, qr: null, status: 'INITIALIZING' });

    sock.ev.on('creds.update', saveCreds);

    // =======================================================================
    // LISTENER EN VIVO: Captura el clic de contingencia ("Click-to-Chat")
    // =======================================================================
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (msg.key.fromMe || msg.key.remoteJid.endsWith('@g.us')) continue;

            const incomingText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            const cleanText = incomingText.trim().toLowerCase();

            if (cleanText.includes('solicito mi codigo otp') || cleanText.includes('solicito mi código otp')) {
                const targetJid = msg.key.remoteJid;
                const rawPhone = targetJid.split('@')[0].replace(/\D/g, ''); // Ej: "989876543" o "51989876543"

                // 1. EVITAR DUPLICADOS EN LA MISMA FRACCIÓN DE SEGUNDO
                const msgKey = `proc:${msg.key.id}`;
                if (pendingOtps.has(msgKey)) continue; 
                pendingOtps.set(msgKey, true);
                setTimeout(() => pendingOtps.delete(msgKey), 10000);

                console.log(`[${instanceId}] Buscando código para el remitente real de WhatsApp: ${rawPhone}`);

                // 2. BÚSQUEDA ROBUSTA POR COINCIDENCIA DE COLA TELEFÓNICA (Últimos 8 dígitos)
                let activeCode = null;
                const rawPhoneTail = rawPhone.length >= 8 ? rawPhone.slice(-8) : rawPhone;
                
                for (const [savedPhone, savedCode] of pendingOtps.entries()) {
                    // Saltamos las llaves de control de ráfaga de duplicados
                    if (savedPhone.startsWith('proc:')) continue;

                    const savedPhoneTail = savedPhone.length >= 8 ? savedPhone.slice(-8) : savedPhone;

                    // Si las colas de los números coinciden exactamente, tenemos un Match perfecto 
                    // de usuario internacional sin importar el prefijo que traiga Meta.
                    if (rawPhoneTail === savedPhoneTail) {
                        activeCode = savedCode;
                        console.log(`[${instanceId}] 🎯 Match Exitoso Encontrado -> Registrado: ${savedPhone} <==> Remitente WA: ${rawPhone}`);
                        break;
                    }
                }

                let messageToReply = '';

                if (activeCode) {
                    messageToReply = `Tu código de verificación solicitado es: *${activeCode}*.\nIntrodúcelo en la casilla de tu pantalla actual.`;
                } else {
                    console.warn(`[${instanceId}] ❌ No hubo coincidencia en RAM para: ${rawPhone}. Claves activas:`, 
                        Array.from(pendingOtps.keys()).filter(k => !k.startsWith('proc:'))
                    );
                    messageToReply = `Intenta registrarte nuevamente desde la web para proporcionarte el código`;
                }

                try {
                    // Simulación humana en el chat abierto
                    await sock.sendPresenceUpdate('composing', targetJid);
                    await delay(1200);
                    await sock.sendPresenceUpdate('paused', targetJid);

                    await sock.sendMessage(targetJid, { text: messageToReply });
                    console.log(`[${instanceId}] Contingencia respondida con éxito a: ${rawPhone}`);
                } catch (err) {
                    console.error(`[${instanceId}] Error enviando respuesta en el Listener:`, err);
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

// 3. Enviar OTP seleccionando la instancia (ESTRATEGIA ATÓMICA POR DESVÍO DIRECTO)
app.post('/instance/send-otp', async (req, res) => {
    const { instanceId, phone, code, message } = req.body;

    if (!instanceId || !phone || !code) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios: instanceId, phone o code' });
    }

    const instance = instances.get(instanceId);
    if (!instance || instance.status !== 'CONNECTED') {
        return res.status(400).json({ error: `La instancia [${instanceId}] no está conectada o lista.` });
    }

    const cleanedPhone = phone.trim().replace(/\D/g, ''); // Elimina cualquier caracter no numérico

    // Guardamos la versión completa tal cual viene
    pendingOtps.set(cleanedPhone, code);
    
    // Guardamos también la variante de los últimos 9 dígitos por si el JID de entrada difiere en prefijos
    if (cleanedPhone.length >= 9) {
        const globalShortForm = cleanedPhone.slice(-9);
        pendingOtps.set(globalShortForm, code);
    }
    
    // El registro vive estrictamente 5 minutos y luego se limpia solo
    setTimeout(() => {
        if (pendingOtps.get(cleanedPhone) === code) {
            pendingOtps.delete(cleanedPhone);
            console.log(`[Memory Garbage Collector] Código expirado y limpiado para: ${cleanedPhone}`);
        }
    }, 5 * 60 * 1000);

    try {
        let targetJid = `${cleanedPhone}@s.whatsapp.net`;

        // Verificación rápida de existencia en WhatsApp
        const [resultWhatsApp] = await instance.sock.onWhatsApp(cleanedPhone);
        if (!resultWhatsApp || !resultWhatsApp.exists) {
            return res.status(404).json({ error: `El número ${cleanedPhone} no está registrado en WhatsApp.` });
        }
        
        targetJid = resultWhatsApp.jid;

        // 2. DISPARO DE FONDO (Asíncrono - No bloqueante)
        // Intentamos enviar el mensaje por detrás. Si sale, genial. Si da error 463 en consola, no nos importa,
        // porque la petición HTTP ya habrá respondido al cliente habilitando el plan B.
        const finalMessage = message || `Tu código de verificación es: *${code}*.\nExpirará en 5 minutos.`;
        
        instance.sock.sendMessage(targetJid, { text: finalMessage })
            .then(() => console.log(`[Background Send] Intento de envío directo procesado para ${cleanedPhone}`))
            .catch((err) => console.error(`[Background Send] Error silencioso de fondo:`, err.message));

        // =======================================================================
        // 3. RESPUESTA INMEDIATA DE CONTINGENCIA
        // Forzamos isRestricted: true para obligar al Frontend a activar el botón interactivo.
        // =======================================================================
        console.log(`[🚀 Contingencia Forzada] Habilitando bypass interactivo para el número: ${cleanedPhone}`);
        return res.status(200).json({ 
            success: true, 
            isRestricted: true, 
            message: 'Bypass de contingencia proactivo activado para entornos de producción (Render).' 
        });

    } catch (error) {
        console.error(`[${instanceId}] Error crítico en pasarela OTP:`, error);
        return res.status(500).json({ 
            error: 'Error interno en pasarela', 
            details: error.message, 
            isRestricted: false 
        });
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