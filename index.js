const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const AUTH_DIR = path.join(__dirname, "auth_info");
const GROUP_FILE = path.join(__dirname, "group_jid.txt");
const PORT = 3001;

let sock = null;
let isReady = false;
let lastQR = null;
let processingMessage = false; // prevent concurrent AI calls
const botSentIds = new Set(); // track IDs of messages WE sent, to avoid self-reply loops

const MEMORY_FILE = path.join(__dirname, "memory.md");

function loadMemory() {
    try { return fs.readFileSync(MEMORY_FILE, "utf8").trim(); } catch { return ""; }
}

function appendMemory(fact) {
    if (!fact || !fact.trim()) return;
    const entry = `\n- [${new Date().toISOString().slice(0, 10)}] ${fact.trim()}`;
    fs.appendFileSync(MEMORY_FILE, entry, "utf8");
    console.log(`[Memory] Saved: ${fact.trim().slice(0, 80)}`);
}

function loadGroupJid() {
    try { return fs.readFileSync(GROUP_FILE, "utf8").trim(); } catch { return null; }
}

function saveGroupJid(jid) {
    fs.writeFileSync(GROUP_FILE, jid, "utf8");
}

function askClaude(question) {
    return new Promise((resolve) => {
        const memory = loadMemory();
        const memorySection = memory
            ? `\n\n## Remembered from past conversations:\n${memory}`
            : "";
        const prompt = `User question: ${question}${memorySection}\n\nIf you learn something worth remembering (user preferences, notable data patterns, recurring questions), add it at the very end after a line containing only "MEMORY:" — one short sentence. Otherwise omit the MEMORY section entirely.`;

        const proc = spawn("sudo", ["-u", "username", "/home/username/.local/bin/claude", "-p", prompt, "--dangerously-skip-permissions"], {
            env: { ...process.env, HOME: "/home/username" },
            cwd: __dirname, // loads CLAUDE.md automatically
        });

        let output = "";
        let errout = "";
        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data", (d) => (errout += d.toString()));

        const timer = setTimeout(() => {
            proc.kill();
            resolve("⏱ תם הזמן. נסה שוב.");
        }, 120000);

        proc.on("close", (code) => {
            clearTimeout(timer);
            const raw = output.trim();
            if (errout) console.error("[claude stderr]", errout.slice(0, 500));
            if (!raw) console.error("[claude] empty output, exit code:", code);
            const memoryMatch = raw.match(/\nMEMORY:\s*\n?([\s\S]+)$/i);
            const answer = memoryMatch
                ? raw.slice(0, memoryMatch.index).trim()
                : raw;
            if (memoryMatch) appendMemory(memoryMatch[1].trim());
            if (!answer) resolve("❌ לא הצלחתי לעבד את השאלה");
            else resolve(answer);
        });

        proc.on("error", () => {
            clearTimeout(timer);
            resolve("❌ שגיאה בהפעלת ה-AI");
        });
    });
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = qr;
            console.log("\n📱 Scan this QR code with WhatsApp:\n");
            qrcode.generate(qr, { small: true });
            const imgPath = "/sdcard/DCIM/Screenshots/whatsapp_qr.png";
            QRCode.toFile(imgPath, qr, { width: 400 }, () => {});
            console.log(`\n🌐 Or open in browser: http://localhost:${PORT}/qr\n`);
        }

        if (connection === "close") {
            isReady = false;
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed. Reconnecting:", shouldReconnect);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
            else console.log("Logged out. Delete auth_info folder and restart.");
        }

        if (connection === "open") {
            isReady = true;
            const groupJid = loadGroupJid();
            console.log("✅ WhatsApp connected!" + (groupJid ? ` Group: ${groupJid}` : ""));
        }
    });

    // Listen for group messages and answer with AI
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            const groupJid = loadGroupJid();
            if (!groupJid || msg.key.remoteJid !== groupJid) continue;
            // Skip messages the bot itself sent (to avoid infinite loops)
            if (msg.key.fromMe && botSentIds.has(msg.key.id)) {
                botSentIds.delete(msg.key.id);
                continue;
            }

            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption;
            if (!text || !text.trim()) continue;

            console.log(`[Group] Question: ${text}`);

            if (processingMessage) {
                await sock.sendMessage(groupJid, { text: "⏳ מעבד שאלה קודמת, רגע..." });
                continue;
            }

            processingMessage = true;
            try {
                const waitMsg = await sock.sendMessage(groupJid, { text: "⏳ מחפש..." });
                if (waitMsg?.key?.id) botSentIds.add(waitMsg.key.id);
                const answer = await askClaude(text.trim());
                const answerMsg = await sock.sendMessage(groupJid, { text: answer });
                if (answerMsg?.key?.id) botSentIds.add(answerMsg.key.id);
                console.log(`[Group] Answer sent (${answer.length} chars)`);
            } catch (e) {
                console.error("Group message handler error:", e);
                const errMsg = await sock.sendMessage(groupJid, { text: "❌ שגיאה" });
                if (errMsg?.key?.id) botSentIds.add(errMsg.key.id);
            } finally {
                processingMessage = false;
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
}

const server = http.createServer(async (req, res) => {
    const notReady = () => { res.writeHead(503); res.end(JSON.stringify({ error: "WhatsApp not connected yet" })); };

    if (req.method === "POST" && req.url === "/send") {
        try {
            const { phone, message } = await parseBody(req);
            if (!isReady) return notReady();
            let jid;
            if (phone) {
                jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
            } else {
                jid = loadGroupJid();
                if (!jid) { res.writeHead(400); return res.end(JSON.stringify({ error: "No group created yet" })); }
            }
            await sock.sendMessage(jid, { text: message });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, jid }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }

    } else if (req.method === "POST" && req.url === "/group/create") {
        try {
            const { name, participants } = await parseBody(req);
            if (!isReady) return notReady();
            const jids = participants.map(p => p.includes("@") ? p : `${p}@s.whatsapp.net`);
            const result = await sock.groupCreate(name || "דירות Yad2", jids);
            saveGroupJid(result.id);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, groupJid: result.id }));
        } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }

    } else if (req.method === "GET" && req.url === "/group") {
        res.writeHead(200);
        res.end(JSON.stringify({ groupJid: loadGroupJid() }));

    } else if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200);
        res.end(JSON.stringify({ ready: isReady, groupJid: loadGroupJid() }));

    } else if (req.method === "GET" && req.url === "/qr") {
        if (isReady) {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end("<h2>✅ WhatsApp already connected!</h2>");
        }
        if (!lastQR) {
            res.writeHead(503, { "Content-Type": "text/html" });
            return res.end("<h2>No QR yet, try again in a few seconds...</h2>");
        }
        QRCode.toDataURL(lastQR, { width: 400 }, (err, url) => {
            if (err) { res.writeHead(500); return res.end("Error"); }
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<html><body style="text-align:center;background:#fff;padding:20px">
                <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
                <img src="${url}" style="width:300px;height:300px"/>
                <p><a href="/qr">Refresh</a></p></body></html>`);
        });

    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`WhatsApp sender listening on port ${PORT}`);
});

connectToWhatsApp();
