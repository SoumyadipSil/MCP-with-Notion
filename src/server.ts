import express from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import axios from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const notionApiKey = process.env.NOTION_API_KEY;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const serverPath = path.resolve(__dirname, "../mcp-notion-server/build/index.js");

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;

// Initialize MCP Client once
async function initMcp() {
    if (mcpClient) return;
    try {
        console.log("Initializing MCP Server...");
        mcpTransport = new StdioClientTransport({
            command: "node",
            args: [serverPath],
            env: {
                ...process.env,
                NOTION_API_TOKEN: notionApiKey
            }
        });
        mcpClient = new Client(
            { name: "notion-trust-agent-web", version: "1.0.0" },
            { capabilities: { tools: {} } }
        );
        await mcpClient.connect(mcpTransport);
        console.log("MCP Server connected.");
    } catch (error) {
        console.error("Error initializing MCP:", error);
    }
}

app.post("/api/search", async (req, res) => {
    try {
        const { query, password } = req.body;

        if (password !== "Soumyadip123") {
            return res.status(401).json({ error: "Invalid access code." });
        }
        if (!query) {
            return res.status(400).json({ error: "Query is required." });
        }

        await initMcp();
        if (!mcpClient) throw new Error("MCP client not available.");

        // 1. Search Notion
        const findResult = await mcpClient.callTool({
            name: "notion_find",
            arguments: { query, type: "page" }
        });

        const mcpContent = findResult.content as any[];
        const searchDataText = mcpContent.find(c => c.type === 'text')?.text || '[]';
        const searchData = JSON.parse(searchDataText);
        
        let contextContent = "";
        const topPages = searchData.results?.slice(0, 3) || [];
        
        if (topPages.length === 0) {
            return res.json({
                answer: "I couldn't find any relevant pages in the workspace to answer your query.",
                confidenceLabel: "Insufficient data",
                reasoning: "No matching pages found by the MCP search tool."
            });
        }

        // 2. Read Pages
        for (const page of topPages) {
            try {
                const readResult = await mcpClient.callTool({
                    name: "notion_read_page",
                    arguments: {
                        page_id: page.id,
                        include_properties: true,
                        content_format: "markdown"
                    }
                });
                const readContent = readResult.content as any[];
                const pageText = readContent.find(c => c.type === 'text')?.text || '';
                contextContent += `\n\n--- Page: ${page.title || page.id} ---\n${pageText}`;
            } catch (err: any) {
                contextContent += `\n\n--- Page: ${page.title || page.id} ---\nError retrieving page: ${err.message || '404 or insufficient permissions'}`;
            }
        }

        // 3. OpenRouter LLM
        const systemPrompt = `
You are a highly precise enterprise assistant answering based on the provided Notion context.
If the answer is not in the context, explicitly state that the documents do not contain the answer.

Context:
${contextContent}

You MUST return your response as a valid JSON object in the exact following format:
{
  "answer": "your detailed, well-formatted answer here",
  "sources_agree": true or false,
  "confidence_reasoning": "brief explanation of why the sources agree or disagree and if the information seems sufficient"
}
`;
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "nvidia/nemotron-3-super-120b-a12b:free",
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: query }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${openRouterApiKey}`,
                    "Content-Type": "application/json"
                }
            }
        );

        let parsedResponse: any = {};
        const llmContent = response.data.choices[0].message.content;
        try {
            const cleanLlmContent = llmContent.replace(/```json/g, '').replace(/```/g, '').trim();
            parsedResponse = JSON.parse(cleanLlmContent);
        } catch (e) {
            parsedResponse = { answer: llmContent, sources_agree: true, confidence_reasoning: "Failed to parse JSON." };
        }

        // 4. Calculate Confidence
        let confidenceLabel = "High confidence";
        if (topPages.length === 1) {
             confidenceLabel = "Medium confidence (Only 1 source found)";
        } else if (!parsedResponse.sources_agree) {
             confidenceLabel = "Conflicting sources";
        }

        res.json({
            answer: parsedResponse.answer,
            confidenceLabel,
            reasoning: parsedResponse.confidence_reasoning
        });

    } catch (e: any) {
        console.error("Search Error:", e);
        res.status(500).json({ error: e.message || "An error occurred during search." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    initMcp(); // Start MCP immediately
});
