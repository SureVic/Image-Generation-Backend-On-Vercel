const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Custom Modules
const { authenticateToken, JWT_SECRET } = require('./src/middleware/auth');
const { enhancePrompt, ADVANCED_IMAGE_GUIDANCE } = require('./src/utils/promptHelper');
const { generateWithCloudflareFlux, generateWithPollinations } = require('./src/services/imageService');

const app = express();

// Middleware Configuration
app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Storage & Upload Config
const upload = multer({ storage: multer.memoryStorage() }).single('image');

// In-memory Job Management
const queue = [];
const jobs = new Map();
let isProcessing = false;

/**
 * Core Queue Processor
 */
async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    while (queue.length > 0) {
        const jobId = queue.shift();
        const job = jobs.get(jobId);
        job.status = 'processing';

        try {
            let fullPrompt = enhancePrompt(job.prompt, job.style);

            // Map aspect ratios
            const ratioMap = {
                '21:9': { w: 1512, h: 648 }, '16:9': { w: 1344, h: 768 },
                '4:3': { w: 1152, h: 864 }, '1:1': { w: 1024, h: 1024 },
                '3:4': { w: 864, h: 1152 }, '9:16': { w: 768, h: 1344 }
            };
            const dims = ratioMap[job.resolution] || { w: 1024, h: 1024 };

            if (job.imageBuffer) {
                fullPrompt = `${ADVANCED_IMAGE_GUIDANCE(job.resolution)}\nUser Prompt: ${fullPrompt}`;
            }

            let imageUrl;
            try {
                imageUrl = await generateWithCloudflareFlux(fullPrompt, job.imageBuffer, dims.w, dims.h);
            } catch (err) {
                console.warn('Cloudflare failed, attempting fallback...');
                imageUrl = await generateWithPollinations(fullPrompt, dims.w, dims.h);
            }

            job.status = 'completed';
            job.url = imageUrl;
            delete job.imageBuffer;
        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
        }
    }
    isProcessing = false;
}

// --- API ROUTES ---

/**
 * Login Endpoint
 */
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    // Check against .env credentials
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });

        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        });

        return res.json({ success: true, email });
    }

    res.status(401).json({ error: 'Invalid credentials. Access denied.' });
});

/**
 * Logout Endpoint
 */
app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

/**
 * Auth Verification
 */
app.get('/api/check-auth', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

/**
 * Image Generation Endpoint
 */
app.post('/api/generate', authenticateToken, (req, res) => {
    upload(req, res, (err) => {
        if (err) return res.status(400).json({ error: 'Upload failed' });

        const { prompt, style, resolution } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        const jobId = uuidv4();
        jobs.set(jobId, {
            id: jobId, prompt, style, resolution,
            imageBuffer: req.file ? req.file.buffer : null,
            status: 'queued', createdAt: Date.now()
        });

        queue.push(jobId);
        processQueue();
        res.json({ id: jobId, status: 'queued' });
    });
});

/**
 * Job Status Endpoint
 */
app.get('/api/status/:id', authenticateToken, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

/**
 * History Endpoint
 */
app.get('/api/history', authenticateToken, (req, res) => {
    const history = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ history });
});

// Prompt Enhancement Proxy
app.post('/api/enhance', (req, res) => {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    const enhanced = enhancePrompt(prompt, style || 'realistic');
    res.json({ enhanced });
});

// Static Assets & Frontend Serving
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'frontend/dist')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Antigravity Server Running on port ${PORT}`);
});
