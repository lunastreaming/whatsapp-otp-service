const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const instances = new Map();

async function initInstance(instanceId) {
    if (instances.has(instanceId)) {
        console.log(`[${instanceId}] La instancia ya se encuentra activa en memoria.`);
        return;
    }

    const sessionPath = path.join(__dirname, 'sessions', instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true 
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
            
            if (shouldReconnect) {
                instances.delete(instanceId);
                initInstance(instanceId); 
            } else {
                console.log(`[${instanceId}] Sesión destruida por el usuario.`);
                instances.delete(instanceId);
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

// 3. Enviar OTP seleccionando la instancia (CON MEJORAS ANTIBLOQUEO)
app.post('/instance/send-otp', async (req, res) => {
    const { instanceId, phone, code } = req.body;

    if (!instanceId || !phone || !code) {
        return res.status(400).json({ error: 'Faltan parámetros obligatorios: instanceId, phone o code' });
    }

    const instance = instances.get(instanceId);
    if (!instance || instance.status !== 'CONNECTED') {
        return res.status(400).json({ error: `La instancia [${instanceId}] no está conectada o lista.` });
    }

    try {
        const cleanedPhone = phone.trim();
        let targetJid = `${cleanedPhone}@s.whatsapp.net`;

        // MEJORA 1: Sincronización y verificación previa del contacto en los servidores de WhatsApp
        // Esto fuerza a Meta a reconocer el número y genera metadatos de handshake iniciales
        const [result] = await instance.sock.onWhatsApp(cleanedPhone);
        
        if (!result || !result.exists) {
            return res.status(404).json({ error: `El número ${cleanedPhone} no está registrado en WhatsApp.` });
        }
        
        // Usamos el JID formateado/validado exacto devuelto por WhatsApp
        targetJid = result.jid;

        // MEJORA 2: Simulación de presencia "Composing" (Escribiendo...)
        // Esto le avisa al servidor de WhatsApp que un humano está interactuando con la interfaz
        await instance.sock.sendPresenceUpdate('composing', targetJid);
        
        // Espera de 2 segundos simulando la escritura
        await new Promise(resolve => setTimeout(resolve, 2000));

        // MEJORA 3: Pausar el estado de escritura justo antes de enviar
        await instance.sock.sendPresenceUpdate('paused', targetJid);

        const message = `Tu código de verificación es: *${code}*.\nExpirará en 5 minutos.`;

        // Envío final del mensaje
        await instance.sock.sendMessage(targetJid, { text: message });
        
        return res.status(200).json({ success: true, message: 'OTP enviado con éxito' });
    } catch (error) {
        // Captura avanzada del error para que tu backend sepa exactamente si fue el Error 463
        console.error(`[${instanceId}] Error al enviar OTP:`, error);
        return res.status(500).json({ 
            error: 'Error al enviar el mensaje', 
            details: error.message,
            isRestricted: error.message?.includes('463') // Útil si tu backend quiere cambiar a SMS automáticamente
        });
    }
});

// 4. Servidor en escucha y auto-restauración
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

// 3.5 Enviar Mensaje Genérico (Optimizado igual que el OTP)
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

        // Mismas mejoras de comportamiento aplicadas aquí
        const [result] = await instance.sock.onWhatsApp(cleanedPhone);
        if (result && result.exists) {
            targetJid = result.jid;
        }

        await instance.sock.sendPresenceUpdate('composing', targetJid);
        await new Promise(resolve => setTimeout(resolve, 1500));
        await instance.sock.sendPresenceUpdate('paused', targetJid);

        await instance.sock.sendMessage(targetJid, { text: message });
        
        return res.status(200).json({ success: true, message: 'Mensaje de flujo enviado con éxito' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al enviar el mensaje de flujo', details: error.message });
    }
});