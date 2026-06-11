const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Orquestador en memoria para almacenar las instancias activas
const instances = new Map();

// Función principal para inicializar una instancia de WhatsApp
async function initInstance(instanceId) {
    if (instances.has(instanceId)) {
        console.log(`[${instanceId}] La instancia ya se encuentra activa en memoria.`);
        return;
    }

    // Cada instancia guardará sus credenciales en una carpeta separada: sessions/id_instancia
    const sessionPath = path.join(__dirname, 'sessions', instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true // Muestra el QR en la consola por comodidad
    });

    // Guardar la instancia básica en nuestro mapa global
    instances.set(instanceId, { sock, qr: null, status: 'INITIALIZING' });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const currentInstance = instances.get(instanceId);

        if (qr) {
            // Guardamos el código QR en Base64 para poder consumirlo vía API HTTP
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
                initInstance(instanceId); // Intenta reconectar de forma automática
            } else {
                // Si el usuario cerró sesión explícitamente en el teléfono
                console.log(`[${instanceId}] Sesión destruida por el usuario.`);
                instances.delete(instanceId);
                fs.rmSync(sessionPath, { recursive: true, force: true }); // Limpia los archivos
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

// ==========================================
// ENDPOINTS DE LA API
// ==========================================

// 1. Crear o inicializar una instancia (ej: instanceId = "bot-soporte", "bot-ventas")
app.post('/instance/init', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Falta el parámetro instanceId' });

    await initInstance(instanceId);
    return res.status(200).json({ message: `Inicializando instancia: ${instanceId}` });
});

// 2. Obtener el estado y el código QR de una instancia para poder escanearlo
app.get('/instance/qr/:instanceId', (req, res) => {
    const { instanceId } = req.params;
    const instance = instances.get(instanceId);

    if (!instance) return res.status(404).json({ error: 'Instancia no encontrada' });

    return res.status(200).json({
        instanceId,
        status: instance.status,
        qr: instance.qr // Retorna el string Base64 (puedes meterlo directo en una etiqueta <img src="..."/>)
    });
});

// 3. Endpoint modificado para enviar OTP seleccionando la instancia
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
        const jid = `${phone}@s.whatsapp.net`;
        const message = `Tu código de verificación es: *${code}*.\nExpirará en 5 minutos.`;

        await instance.sock.sendMessage(jid, { text: message });
        return res.status(200).json({ success: true, message: 'OTP enviado con éxito' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al enviar el mensaje', details: error.message });
    }
});

// 4. Auto-conectar instancias existentes al iniciar el servidor
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`API Multi-Instancia corriendo en http://localhost:${PORT}`);
    
    // Opcional: Lee la carpeta 'sessions' y levanta automáticamente los números previamente escaneados
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