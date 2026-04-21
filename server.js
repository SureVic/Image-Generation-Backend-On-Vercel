const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();

// Updated CORS to handle credentials properly
app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
        }
    },
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for handling memory storage for uploaded images
const storage = multer.memoryStorage();
const upload = multer({ storage: storage }).single('image');

// Simple queue system
const queue = [];
const jobs = new Map(); // id -> { status, url, prompt, error, imageBuffer }

const JWT_SECRET = process.env.JWT_SECRET || 'antigravity_secret_123';

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden: Invalid token' });
        req.user = user;
        next();
    });
};

let isProcessing = false;

// Mock prompt enhancer using template rules
const enhancePrompt = (prompt, style) => {
    const enhancements = {
        'realistic': 'ultra-realistic, highly detailed, 8k resolution, photorealistic, photography, canon eos 5d mark iv, sharp focus',
        'cinematic': 'cinematic lighting, dramatic, movie still, beautifully lit, volumetric lighting, epic composition',
        '3d': '3d render, octane render, unreal engine 5, ray tracing, highly detailed 3d model, masterpiece',
        'anime': 'anime style, studio ghibli, makoto shinkai style, high quality illustration, vibrant colors, detailed anime art'
    };
    const suffix = enhancements[style] || '';
    return `${prompt}, ${suffix}`;
};

const ADVANCED_IMAGE_GUIDANCE = (ratio) => `
### NEXT MOMENT GENERATION - SYSTEM INSTRUCTION:
You are an advanced AI image generation system.

Your task is to generate the NEXT MOMENT of the uploaded reference image (input_image_0).

🔴 Core Instruction (VERY IMPORTANT):
- The generated image must represent what happens immediately AFTER the reference image (input_image_0).
- Do NOT create a different scene.
- Do NOT change the subject or environment.

🔹 Next Moment Logic:
- Predict a natural continuation of the scene.
- If a person is standing → slight movement, gesture, or expression change.
- If an object is in motion → continue that motion realistically.
- If environment is static → introduce subtle realistic changes (wind, light shift, movement).

🔹 Subject Consistency:
- Keep the SAME person / object / animal from input_image_0.
- Maintain identity, structure, clothing, and features exactly. No new characters.

🔹 Composition & Style:
- Keep similar camera angle and framing.
- Output Ratio: ${ratio} (MANDATORY).
- Style: Highly realistic, Cinematic lighting, Sharp focus, high detail.

🔹 Rules & Constraints:
- Creativity: LOW | Variation: Minimal | Consistency: HIGH.
- Negative: No new scenes, No fantasy transformations, No distortions.

🔹 Final Instruction:
- Ensure the output looks like the immediate natural continuation of input_image_0.
- Follow the ${ratio} aspect ratio strictly.
`;

app.post('/api/enhance', (req, res) => {
    const { prompt, style } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Simulate slight delay for "AI" enhancement
    setTimeout(() => {
        const enhanced = enhancePrompt(prompt, style || 'realistic');
        res.json({ enhanced });
    }, 600);
});

// Cloudflare Workers AI Flux Generation Logic
async function generateWithCloudflareFlux(prompt, imageBuffer = null, width = 1024, height = 1024) {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
        throw new Error('Cloudflare credentials missing in environment.');
    }

    try {
        // Use flux-2-dev for image-to-image or image reference
        const model = imageBuffer ? '@cf/black-forest-labs/flux-2-dev' : '@cf/black-forest-labs/flux-1-schnell';
        console.log(`Generating image using Cloudflare (${model})...`);

        const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`;

        let response;
        if (imageBuffer) {
            const form = new FormData();
            form.append('prompt', prompt);
            form.append('image', imageBuffer, { filename: 'reference.png', contentType: 'image/png' });
            form.append('input_image_0', imageBuffer, { filename: 'reference.png', contentType: 'image/png' });
            form.append('width', width.toString());
            form.append('height', height.toString());
            form.append('strength', '0.8'); // Even more strict adherence to the image 0.8

            console.log(`[Cloudflare] Sending I2I: prompt="${prompt.substring(0, 50)}...", fields: image, input_image_0, size: ${imageBuffer.length}`);

            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
                    ...form.getHeaders()
                },
                body: form
            });
        } else {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    prompt: prompt,
                    width: width,
                    height: height
                })
            });
        }

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.errors?.[0]?.message || `HTTP ${response.status}: Failed to generate image`);
        }

        const contentType = response.headers.get('content-type');
        console.log('Cloudflare Response Content-Type:', contentType);

        if (contentType && contentType.includes('application/json')) {
            const result = await response.json();
            if (result.result && result.result.image) {
                return `data:image/png;base64,${result.result.image}`;
            } else {
                throw new Error('Cloudflare returned JSON but no image data found.');
            }
        } else {
            // Assume binary image (PNG)
            const buffer = await response.buffer();
            const base64Image = buffer.toString('base64');
            return `data:image/png;base64,${base64Image}`;
        }
    } catch (err) {
        console.error('Cloudflare Flux Request Failed:', err.message);
        throw err;
    }
}

// Fallback: Pollinations.ai (Free & Unlimited)
async function generateWithPollinations(prompt, width = 1024, height = 1024) {
    console.log('Using Pollinations.ai fallback...');

    // Clean prompt for fallback to avoid URL length and compatibility issues
    // We remove the long safety guidance block for the fallback URL to ensure it stays within limits
    const cleanPrompt = prompt.split('INSTRUCTIONS FOR IMAGE GENERATION:')[0].trim();
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(cleanPrompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&model=flux&nologo=true`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Pollinations failed with status ${response.status}`);

        const contentType = response.headers.get('content-type');
        if (contentType && !contentType.includes('image')) {
            throw new Error(`Pollinations returned non-image content: ${contentType}`);
        }

        const buffer = await response.buffer();
        console.log(`Pollinations returned ${buffer.length} bytes`);

        const base64Image = buffer.toString('base64');
        const mimeType = contentType || 'image/png';
        return `data:${mimeType};base64,${base64Image}`;
    } catch (err) {
        console.error('Pollinations Error:', err.message);
        throw new Error('All image generation providers are currently unavailable.');
    }
}

// Processor
async function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    while (queue.length > 0) {
        const jobId = queue.shift();
        const job = jobs.get(jobId);

        job.status = 'processing';
        console.log(`Processing job ${jobId}: ${job.prompt}`);

        try {
            // Enhanced prompt
            let fullPrompt = enhancePrompt(job.prompt, job.style);

            // Map aspect ratio to dimensions
            const ratioMap = {
                '21:9': { w: 1512, h: 648 },
                '16:9': { w: 1344, h: 768 },
                '4:3': { w: 1152, h: 864 },
                '1:1': { w: 1024, h: 1024 },
                '3:4': { w: 864, h: 1152 },
                '9:16': { w: 768, h: 1344 }
            };
            const dims = ratioMap[job.resolution] || { w: 1024, h: 1024 };

            // Apply advanced guidance and aspect ratio instructions
            if (job.imageBuffer) {
                fullPrompt = `${ADVANCED_IMAGE_GUIDANCE(job.resolution)}\nUser Prompt for variation: ${fullPrompt}`;
            } else {
                fullPrompt = `${fullPrompt}\nSTRICT ASPECT RATIO: ${job.resolution}`;
            }

            let imageUrl;
            try {
                imageUrl = await generateWithCloudflareFlux(fullPrompt, job.imageBuffer, dims.w, dims.h);
            } catch (cfError) {
                // If Cloudflare fails due to quota (neurons) or other errors, try fallback
                if (cfError.message.includes('neurons') || cfError.message.includes('allocation') || cfError.message.includes('rate limit')) {
                    console.warn('!!! CLOUDFLARE QUOTA REACHED !!! Switching to free fallback (Note: Image-to-image coherence may decrease)');
                    imageUrl = await generateWithPollinations(fullPrompt, dims.w, dims.h);
                } else {
                    throw cfError;
                }
            }

            job.status = 'completed';
            job.url = imageUrl;
            // Clean up buffer after use to save memory
            delete job.imageBuffer;
        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
        }
    }

    isProcessing = false;
}

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    const users = [
        { email: process.env.ADMIN_EMAIL_1, password: process.env.ADMIN_PASSWORD_1 },
        { email: process.env.ADMIN_EMAIL_2, password: process.env.ADMIN_PASSWORD_2 }
    ];

    const user = users.find(u => u.email === email);

    if (user && user.password === password) {
        const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '24h' });

        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        return res.json({ success: true, email: user.email });
    }

    res.status(401).json({ error: 'Access Denied: Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/check-auth', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.post('/api/generate', authenticateToken, (req, res) => {
    upload(req, res, (err) => {
        if (err) return res.status(400).json({ error: 'Image upload failed' });

        const { prompt, style, resolution } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        const jobId = uuidv4();
        jobs.set(jobId, {
            id: jobId,
            prompt,
            style,
            resolution,
            imageBuffer: req.file ? req.file.buffer : null,
            status: 'queued',
            createdAt: Date.now()
        });

        queue.push(jobId);
        processQueue();

        res.json({ id: jobId, status: 'queued' });
    });
});

// Protect history and status routes
app.get('/api/status/:id', authenticateToken, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json(job);
});

app.get('/api/history', authenticateToken, (req, res) => {
    const history = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ history });
});

// Serve static files from the React frontend app
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

