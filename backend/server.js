require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { TwitterApi } = require('twitter-api-v2');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Simple Logging Middleware
app.use((req, res, next) => {
    const log = `[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}\n`;
    fs.appendFile(path.join(__dirname, 'server.log'), log, (err) => {
        if (err) console.error("Logging failed", err);
    });
    next();
});

// Helper: Preprocess text (Remove emojis and special characters)
const preprocessText = (text) => {
    return text
        .replace(/[^\x00-\x7F]/g, "") // Remove emojis/non-ASCII
        .replace(/[^a-zA-Z0-9\s]/g, "") // Remove special characters
        .trim();
};

// Initialize Twitter v2 Client
const token = process.env.TWITTER_BEARER_TOKEN;
const readOnlyClient = token ? new TwitterApi(token).readOnly : null;

// Helper: Run Python Predictor (Batch mode)
const getPythonSentimentBatch = (texts) => {
    return new Promise((resolve, reject) => {
        const cleanedTexts = texts.map(preprocessText);
        const tempFilePath = path.join(__dirname, `batch_${Date.now()}_${Math.floor(Math.random()*1000)}.json`);
        // Write data to temporary file
        fs.writeFileSync(tempFilePath, JSON.stringify(cleanedTexts));

        const scriptPath = path.join(__dirname, '..', 'ml', 'predict.py');
        
        exec(`python3 "${scriptPath}" "${tempFilePath}"`, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            // Cleanup temp file
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

            if (error) {
                console.error("Exec Error:", stderr);
                return resolve(texts.map(() => ({ sentiment: "Neutral", score: 3, confidence: 0.5, toxicity: 0, toxicity_level: "safe", toxicity_categories: [], toxicity_details: {} })));
            }
            
            try {
                const resultsObj = JSON.parse(stdout.trim());
                const finalResults = resultsObj.map((res, i) => {
                    const code = res.code;
                    const confidence = res.confidence || 0.8;
                    const toxicity = res.toxicity || 0;
                    const toxicityLevel = res.toxicity_level || "safe";
                    const toxicityCategories = res.toxicity_categories || [];
                    const toxicityDetails = res.toxicity_details || {};

                    const mapping = {
                        1: { label: "Positive", score: 5 },
                        0: { label: "Negative", score: 1 },
                        2: { label: "Neutral", score: 3 }
                    };

                    const result = mapping[code] || { label: "Neutral", score: 3 };
                    const toxicityThreshold = 0.65;
                    const isHidden = toxicity > toxicityThreshold;

                    return {
                        text: texts[i],
                        sentiment: result.label.toLowerCase(),
                        score: result.score,
                        confidence: confidence,
                        toxicity: toxicity,
                        toxicity_level: toxicityLevel,
                        toxicity_categories: toxicityCategories,
                        toxicity_details: toxicityDetails,
                        hidden: isHidden,
                        message: isHidden ? "Comment hidden due to high toxicity." : null
                    };
                });
                resolve(finalResults);
            } catch (e) {
                console.error("Parse Error:", e);
                resolve(texts.map(() => ({ sentiment: "Neutral", score: 3, confidence: 0.5, toxicity: 0, toxicity_level: "safe", toxicity_categories: [], toxicity_details: {} })));
            }
        });
    });
};

// Helper: Run Python Predictor (Single) returns { code, raw_output }
const getPythonSentiment = (text) => {
    return new Promise((resolve, reject) => {
        const cleanedText = preprocessText(text); // Apply preprocessing before sentiment analysis
        const escapedText = cleanedText.replace(/"/g, '\\"').replace(/\n/g, ' ');
        const scriptPath = path.join(__dirname, '..', 'ml', 'predict.py');
        
        exec(`python3 "${scriptPath}" "${escapedText}"`, (error, stdout, stderr) => {
            if (error) {
                console.error("Exec Error:", stderr);
                return resolve({ sentiment: "Neutral", score: 3, confidence: 0.5, toxicity: 0, toxicity_level: "safe", toxicity_categories: [], toxicity_details: {} });
            }
            
            try {
                const resultObj = JSON.parse(stdout.trim());
                const code = resultObj.code;
                const confidence = resultObj.confidence || 0.8;
                const toxicity = resultObj.toxicity || 0;
                const toxicityLevel = resultObj.toxicity_level || "safe";
                const toxicityCategories = resultObj.toxicity_categories || [];
                const toxicityDetails = resultObj.toxicity_details || {};

                const mapping = {
                    1: { label: "Positive", score: 5 },
                    0: { label: "Negative", score: 1 },
                    2: { label: "Neutral", score: 3 }
                };

                const result = mapping[code] || { label: "Neutral", score: 3 };

                // LOG: Input, Sentiment, and Timestamp
                const resultLog = `[${new Date().toISOString()}] Input: "${cleanedText}" | Sentiment: ${result.label} | Toxicity: ${toxicity} | Level: ${toxicityLevel}\n`;
                fs.appendFile(path.join(__dirname, 'server.log'), resultLog, (err) => {});

                const toxicityThreshold = 0.65;
                const isHidden = toxicity > toxicityThreshold;

                resolve({
                    sentiment: result.label,
                    score: result.score,
                    confidence: confidence,
                    toxicity: toxicity,
                    toxicity_level: toxicityLevel,
                    toxicity_categories: toxicityCategories,
                    toxicity_details: toxicityDetails,
                    hidden: isHidden,
                    message: isHidden ? "Comment hidden due to high toxicity." : null
                });
            } catch (e) {
                console.error("Parse Error:", e);
                resolve({ sentiment: "Neutral", score: 3, confidence: 0.5, toxicity: 0, toxicity_level: "safe", toxicity_categories: [], toxicity_details: {} });
            }
        });
    });
};

// Route 1: Manual Analysis
app.post('/api/analyze', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "Text is required" });
        
        const result = await getPythonSentiment(text);
        res.json({ 
            text, 
            sentiment: result.sentiment.toLowerCase(), 
            score: result.score,
            confidence: result.confidence,
            toxicity: result.toxicity,
            toxicity_level: result.toxicity_level,
            toxicity_categories: result.toxicity_categories,
            toxicity_details: result.toxicity_details,
            hidden: result.hidden,
            message: result.message
        });
    } catch (err) {
        console.error("Route Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Route 2: Live Analyze
app.get('/api/analyze-live', async (req, res) => {
    const keyword = req.query.keyword || 'Apple';
    try {
        let tweets = [];
        try {
            if (!readOnlyClient) throw new Error();
            const search = await readOnlyClient.v2.search(keyword, { max_results: 100, expansions: ['author_id'], 'user.fields': ['username'] });
            const includes = search.includes ? search.includes.users : [];
            tweets = search.data.data.map(t => {
                const user = includes.find(u => u.id === t.author_id);
                return { text: t.text, username: user ? user.username : 'twitterUser' };
            });
        } catch {
            const adjs = ["Tech", "Cool", "Happy", "Sad", "Fast", "Smart", "Red", "Blue"];
            const nouns = ["Guru", "User", "Gamer", "Dev", "Fan", "Critic", "Geek", "Bot"];
            const genUser = () => adjs[Math.floor(Math.random() * adjs.length)] + nouns[Math.floor(Math.random() * nouns.length)] + Math.floor(Math.random() * 9999);
            
            tweets = [
                { text: `I love the new ${keyword} AI features! Amazing work.`, username: genUser() },
                { text: `This ${keyword} product is absolutely trash, hate the new update.`, username: genUser() },
                { text: `The ${keyword} service was just okay today.`, username: genUser() },
                { text: `It's a great day to be using ${keyword}.`, username: genUser() },
                { text: `I am feeling quite neutral about ${keyword} this time.`, username: genUser() },
                { text: `Wow, incredible innovation by the ${keyword} team.`, username: genUser() },
                { text: `Disappointed with the ${keyword} customer support.`, username: genUser() },
                { text: `Can't say much about ${keyword} yet, waiting for more details.`, username: genUser() },
                { text: `Loving every bit of this ${keyword} software!`, username: genUser() },
                { text: `Terrible experience with ${keyword}, would not recommend to anyone.`, username: genUser() },
                { text: `The ${keyword} CEO is a complete idiot. Worst company ever, I hope they go bankrupt.`, username: genUser() },
                { text: `Are you kidding me? ${keyword} support is non-existent. I want my money back!!!`, username: genUser() },
                { text: `I'm going to sue ${keyword} for what they did. This is a scam!`, username: genUser() },
                { text: `Shut up and take my money! ${keyword} is the best thing since sliced bread.`, username: genUser() },
                { text: `Their new policy is discriminatory. I will never buy from ${keyword} again.`, username: genUser() },
                { text: `Who designed this? A moron? The UI for ${keyword} makes me want to puke.`, username: genUser() },
                { text: `They should all be fired. The incompetence at ${keyword} is disgusting.`, username: genUser() },
                { text: `Honestly, ${keyword} is just average. Nothing special, but it works.`, username: genUser() },
                { text: `I will attack anyone who says ${keyword} is bad. Just kidding, but seriously it's great!`, username: genUser() },
                { text: `The latest update broke my entire system. Complete garbage. Fix your stupid app.`, username: genUser() }
            ];
        }

        // Generate at least 2000 items
        let targetCount = 2000;
        let baseTweets = [...tweets];
        while (tweets.length < targetCount) {
            tweets = tweets.concat(baseTweets);
        }
        tweets = tweets.slice(0, targetCount);

        const texts = tweets.map(t => t.text);
        const pythonResults = await getPythonSentimentBatch(texts);

        const results = pythonResults.map((r, i) => ({
            ...r,
            username: tweets[i].username
        }));

        const stats = {
            positive: results.filter(r => r.sentiment === 'positive').length,
            negative: results.filter(r => r.sentiment === 'negative').length,
            neutral: results.filter(r => r.sentiment === 'neutral').length,
            toxicity_stats: {
                safe: results.filter(r => r.toxicity_level === 'safe').length,
                mild: results.filter(r => r.toxicity_level === 'mild').length,
                moderate: results.filter(r => r.toxicity_level === 'moderate').length,
                severe: results.filter(r => r.toxicity_level === 'severe').length
            },
            toxicity_categories: {
                hate_speech: results.filter(r => r.toxicity_categories.includes('hate_speech')).length,
                profanity: results.filter(r => r.toxicity_categories.includes('profanity')).length,
                abusive_language: results.filter(r => r.toxicity_categories.includes('abusive_language')).length,
                threats: results.filter(r => r.toxicity_categories.includes('threats')).length,
                negative_product_feedback: results.filter(r => r.toxicity_categories.includes('negative_product_feedback')).length,
                negative_sentiment: results.filter(r => r.toxicity_categories.includes('negative_sentiment')).length
            },
            hidden_count: results.filter(r => r.hidden).length
        };

        res.json({ results, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route 3: Company Toxic Content Analytics
app.get('/api/toxic-analytics', async (req, res) => {
    const keyword = req.query.keyword || 'Apple';
    const minToxicity = parseFloat(req.query.minToxicity) || 0.3;
    const category = req.query.category; // Optional filter by category
    
    try {
        let tweets = [];
        try {
            if (!readOnlyClient) throw new Error();
            const search = await readOnlyClient.v2.search(keyword, { max_results: 100, expansions: ['author_id'], 'user.fields': ['username'] });
            const includes = search.includes ? search.includes.users : [];
            tweets = search.data.data.map(t => {
                const user = includes.find(u => u.id === t.author_id);
                return { text: t.text, username: user ? user.username : 'twitterUser' };
            });
        } catch {
            const adjs = ["Tech", "Cool", "Happy", "Sad", "Fast", "Smart", "Red", "Blue"];
            const nouns = ["Guru", "User", "Gamer", "Dev", "Fan", "Critic", "Geek", "Bot"];
            const genUser = () => adjs[Math.floor(Math.random() * adjs.length)] + nouns[Math.floor(Math.random() * nouns.length)] + Math.floor(Math.random() * 9999);
            
            tweets = [
                { text: `I love the new ${keyword} AI features! Amazing work.`, username: genUser() },
                { text: `This ${keyword} product is absolutely trash, hate the new update.`, username: genUser() },
                { text: `The ${keyword} service was just okay today.`, username: genUser() },
                { text: `It's a great day to be using ${keyword}.`, username: genUser() },
                { text: `I am feeling quite neutral about ${keyword} this time.`, username: genUser() },
                { text: `Wow, incredible innovation by the ${keyword} team.`, username: genUser() },
                { text: `Disappointed with the ${keyword} customer support.`, username: genUser() },
                { text: `Can't say much about ${keyword} yet, waiting for more details.`, username: genUser() },
                { text: `Loving every bit of this ${keyword} software!`, username: genUser() },
                { text: `Terrible experience with ${keyword}, would not recommend to anyone.`, username: genUser() },
                { text: `The ${keyword} CEO is a complete idiot. Worst company ever, I hope they go bankrupt.`, username: genUser() },
                { text: `Are you kidding me? ${keyword} support is non-existent. I want my money back!!!`, username: genUser() },
                { text: `I'm going to sue ${keyword} for what they did. This is a scam!`, username: genUser() },
                { text: `Shut up and take my money! ${keyword} is the best thing since sliced bread.`, username: genUser() },
                { text: `Their new policy is discriminatory. I will never buy from ${keyword} again.`, username: genUser() },
                { text: `Who designed this? A moron? The UI for ${keyword} makes me want to puke.`, username: genUser() },
                { text: `They should all be fired. The incompetence at ${keyword} is disgusting.`, username: genUser() },
                { text: `Honestly, ${keyword} is just average. Nothing special, but it works.`, username: genUser() },
                { text: `I will attack anyone who says ${keyword} is bad. Just kidding, but seriously it's great!`, username: genUser() },
                { text: `The latest update broke my entire system. Complete garbage. Fix your stupid app.`, username: genUser() }
            ];
        }

        // Generate at least 2000 items
        let targetCount = 2000;
        let baseTweets = [...tweets];
        while (tweets.length < targetCount) {
            tweets = tweets.concat(baseTweets);
        }
        tweets = tweets.slice(0, targetCount);

        const texts = tweets.map(t => t.text);
        const pythonResults = await getPythonSentimentBatch(texts);

        const results = pythonResults.map((r, i) => ({
            ...r,
            username: tweets[i].username
        }));

        // Filter toxic content based on parameters
        let toxicContent = results.filter(r => r.toxicity >= minToxicity);
        
        if (category) {
            toxicContent = toxicContent.filter(r => r.toxicity_categories.includes(category));
        }

        // Generate actionable insights for companies
        const insights = {
            total_analyzed: results.length,
            toxic_content_count: toxicContent.length,
            toxicity_percentage: ((toxicContent.length / results.length) * 100).toFixed(2),
            top_toxicity_categories: {
                hate_speech: toxicContent.filter(r => r.toxicity_categories.includes('hate_speech')).length,
                profanity: toxicContent.filter(r => r.toxicity_categories.includes('profanity')).length,
                abusive_language: toxicContent.filter(r => r.toxicity_categories.includes('abusive_language')).length,
                threats: toxicContent.filter(r => r.toxicity_categories.includes('threats')).length,
                negative_product_feedback: toxicContent.filter(r => r.toxicity_categories.includes('negative_product_feedback')).length,
                negative_sentiment: toxicContent.filter(r => r.toxicity_categories.includes('negative_sentiment')).length
            },
            severity_breakdown: {
                mild: toxicContent.filter(r => r.toxicity_level === 'mild').length,
                moderate: toxicContent.filter(r => r.toxicity_level === 'moderate').length,
                severe: toxicContent.filter(r => r.toxicity_level === 'severe').length
            },
            recommendations: generateRecommendations(toxicContent),
            sample_toxic_comments: toxicContent.slice(0, 10).map(r => ({
                text: r.text,
                username: r.username,
                toxicity_level: r.toxicity_level,
                toxicity_score: r.toxicity,
                categories: r.toxicity_categories,
                details: r.toxicity_details
            }))
        };

        res.json({ keyword, insights, toxic_content: toxicContent });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper: Generate actionable recommendations for companies
function generateRecommendations(toxicContent) {
    const recommendations = [];
    
    const hateSpeechCount = toxicContent.filter(r => r.toxicity_categories.includes('hate_speech')).length;
    const threatCount = toxicContent.filter(r => r.toxicity_categories.includes('threats')).length;
    const profanityCount = toxicContent.filter(r => r.toxicity_categories.includes('profanity')).length;
    const negativeProductCount = toxicContent.filter(r => r.toxicity_categories.includes('negative_product_feedback')).length;
    const severeCount = toxicContent.filter(r => r.toxicity_level === 'severe').length;
    
    if (hateSpeechCount > 0) {
        recommendations.push({
            priority: 'CRITICAL',
            category: 'Hate Speech',
            count: hateSpeechCount,
            action: 'Immediately implement content moderation filters for hate speech. Consider reporting to platform authorities and review community guidelines.'
        });
    }
    
    if (threatCount > 0) {
        recommendations.push({
            priority: 'CRITICAL',
            category: 'Threats',
            count: threatCount,
            action: 'Take immediate action on threatening content. Implement safety measures and consider legal action if necessary.'
        });
    }
    
    if (severeCount > 5) {
        recommendations.push({
            priority: 'HIGH',
            category: 'Severe Toxicity',
            count: severeCount,
            action: 'High volume of severely toxic content detected. Review product/service quality and customer satisfaction immediately.'
        });
    }
    
    if (profanityCount > toxicContent.length * 0.3) {
        recommendations.push({
            priority: 'MEDIUM',
            category: 'Profanity',
            count: profanityCount,
            action: 'Consider implementing language filters and review community engagement strategies.'
        });
    }
    
    if (negativeProductCount > 0) {
        recommendations.push({
            priority: 'HIGH',
            category: 'Negative Product Feedback',
            count: negativeProductCount,
            action: 'Review product quality issues and customer feedback. Consider improving product features, quality control, and customer support to address common complaints.'
        });
    }
    
    if (toxicContent.length > toxicContent.length * 0.2) {
        recommendations.push({
            priority: 'MEDIUM',
            category: 'General Toxicity',
            count: toxicContent.length,
            action: 'Review product features, customer service, and user experience to identify pain points causing negative sentiment.'
        });
    }
    
    if (recommendations.length === 0) {
        recommendations.push({
            priority: 'LOW',
            category: 'General',
            count: 0,
            action: 'Toxic content levels are within acceptable range. Continue monitoring sentiment trends.'
        });
    }
    
    return recommendations;
}

// --- SERVE FRONTEND BUILD ---
app.use(express.static(path.join(__dirname, "../frontend/dist")));

// Catch-all: Send index.html for any request that hasn't been handled
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 API Sync Complete on http://localhost:${PORT}`);
});
