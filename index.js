const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const instances = new Map();

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
        shouldSyncHistoryMessage: () => false // Mitiga errores de descifrado innecesarios en Render
    });

    instances.set(instanceId, { sock, qr: null, status: 'INITIALIZING' });

    sock.ev.on('creds.update', saveCreds);

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
            
            // Limpiamos la instancia actual de memoria
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

// 3. Enviar OTP seleccionando la instancia (CON MANEJO DE ERROR 463 Y AUTO-REINTENTO)
app.post('/instance/send-otp', async (req, res) => {
    const { instanceId, phone, code } = req.body;

    if (!instanceId || !phone || !code) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios: instanceId, phone o code' });
    }

    const instance = instances.get(instanceId);
    if (!instance || instance.status !== 'CONNECTED') {
        return res.status(400).json({ error: `La instancia [${instanceId}] no está conectada o lista.` });
    }

    const maxAttempts = 2;
    let attempt = 0;

    while (attempt < maxAttempts) {
        try {
            attempt++;
            const cleanedPhone = phone.trim();
            let targetJid = `${cleanedPhone}@s.whatsapp.net`;

            // Verificación previa del contacto en los servidores de WhatsApp
            const [result] = await instance.sock.onWhatsApp(cleanedPhone);
            
            if (!result || !result.exists) {
                return res.status(404).json({ error: `El número ${cleanedPhone} no está registrado en WhatsApp.` });
            }
            
            targetJid = result.jid;

            // Comportamiento humano simulado
            await instance.sock.sendPresenceUpdate('composing', targetJid);
            
            // Si es el segundo intento, aumentamos el tiempo de "composing" a 5 segundos para enfriar el canal
            await delay(attempt === 1 ? 2000 : 5000); 
            
            await instance.sock.sendPresenceUpdate('paused', targetJid);

            const message = `Tu código de verificación es: *${code}*.\nExpirará en 5 minutos.`;

            // Envío final del mensaje
            await instance.sock.sendMessage(targetJid, { text: message });
            
            return res.status(200).json({ success: true, message: 'OTP enviado con éxito' });
            
        } catch (error) {
            console.error(`[${instanceId}] Error en intento ${attempt} al enviar OTP:`, error);

            const errorMessage = error.message || '';
            const rawErrorData = error.jsonData || JSON.stringify(error);
            const isRestricted = errorMessage.includes('463') || rawErrorData.includes('463');

            // Si detectamos el error 463 y aún nos queda un intento, pausamos y volvemos a intentar
            if (isRestricted && attempt < maxAttempts) {
                console.warn(`[${instanceId}] Detectado error 463. Esperando 3 segundos antes del reintento...`);
                await delay(3000);
                continue; // Forzar el siguiente ciclo del bucle while
            }

            // Si es otro tipo de error o ya se agotaron los intentos, devolvemos la respuesta definitiva de error
            return res.status(500).json({ 
                error: 'Error al enviar el mensaje de verificación', 
                details: errorMessage,
                isRestricted: isRestricted // Si persiste en true, activa el bypass Click-to-Chat en tu frontend
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