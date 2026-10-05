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
const MAX_SEARCH_PAGES = 4;
const MAX_SEARCH_TERMS = 6;
const MAX_CONTEXT_PAGES = 8;
const MAX_WORKSPACE_PAGES = 80;
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_STOP_WORDS = new Set([
    "about", "after", "and", "are", "can", "did", "does", "for", "from",
    "his", "how", "into", "is", "me", "not", "please", "tell", "that",
    "the", "their", "this", "what", "when", "where", "which", "who",
    "with", "you", "your"
]);

type PageCandidate = { page: any; text?: string; score: number };
let pageCache: { expiresAt: number; pages: any[] } | null = null;

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;

function extractToolJson(result: any): any {
    const text = (result.content as any[] | undefined)?.find(c => c.type === "text")?.text;
    if (!text) throw new Error("Notion MCP returned no text content.");
    return JSON.parse(text);
}

function searchTerms(query: string): string[] {
    return [...new Set(
        query
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter(term => term.length >= 3 && !SEARCH_STOP_WORDS.has(term))
    )].slice(0, MAX_SEARCH_TERMS);
}

function normalizeText(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function scorePage(page: any, text: string, terms: string[]): number {
    const haystack = normalizeText(`${page.title || ""} ${text}`);
    return terms.reduce((score, term) => {
        const matches = haystack.match(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"));
        return score + (matches?.length || 0);
    }, 0);
}

async function listAccessiblePages(): Promise<any[]> {
    if (pageCache && pageCache.expiresAt > Date.now()) return pageCache.pages;

    const pages = new Map<string, any>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES; pageNumber++) {
        const result = await mcpClient!.callTool({
            name: "notion_find",
            arguments: {
                query: "",
                object_type: "page",
                page_size: 100,
                ...(cursor ? { start_cursor: cursor } : {})
            }
        });
        const data = extractToolJson(result);
        for (const page of data.results || []) {
            if (page.id && !pages.has(page.id)) pages.set(page.id, page);
            if (pages.size >= MAX_WORKSPACE_PAGES) break;
        }
        if (pages.size >= MAX_WORKSPACE_PAGES || !data.has_more || !data.next_cursor) break;
        cursor = data.next_cursor;
    }

    pageCache = { expiresAt: Date.now() + PAGE_CACHE_TTL_MS, pages: [...pages.values()] };
    return pageCache.pages;
}

async function findAccessiblePages(query: string): Promise<any[]> {
    const terms = searchTerms(query);
    const queries = [query, ...terms.filter(term => term !== query.toLowerCase())];
    const pages = new Map<string, any>();

    for (const searchQuery of queries) {
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < MAX_SEARCH_PAGES; pageNumber++) {
            const result = await mcpClient!.callTool({
                name: "notion_find",
                arguments: {
                    query: searchQuery,
                    object_type: "page",
                    page_size: 100,
                    ...(cursor ? { start_cursor: cursor } : {})
                }
            });
            const data = extractToolJson(result);
            for (const page of data.results || []) {
                if (page.id && !pages.has(page.id)) pages.set(page.id, page);
            }
            if (!data.has_more || !data.next_cursor) break;
            cursor = data.next_cursor;
        }
    }

    const accessiblePages = await listAccessiblePages();
    const candidates: PageCandidate[] = [];
    for (const page of accessiblePages) {
        if (pages.has(page.id)) {
            candidates.push({ page, score: scorePage(page, "", terms) + 10 });
            continue;
        }
        try {
            const readResult = await mcpClient!.callTool({
                name: "notion_read_page",
                arguments: {
                    page_id: page.id,
                    content_format: "markdown",
                    max_depth: 4,
                    max_blocks: 300,
                    page_size: 100
                }
            });
            const data = extractToolJson(readResult);
            const text = data.content?.markdown || JSON.stringify(data.content || "");
            const score = scorePage(page, text, terms);
            if (score > 0) candidates.push({ page, text, score });
        } catch (error) {
            console.warn(`Unable to index Notion page ${page.id}:`, error);
        }
    }

    return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CONTEXT_PAGES)
        .map(candidate => candidate.page);
}

// Initialize MCP Client once
async function initMcp() {
    if (mcpClient) return;
    try {
        if (!notionApiKey) {
            throw new Error("NOTION_API_KEY is not configured.");
        }
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
        let contextContent = "";
        const topPages = await findAccessiblePages(query);
        
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
                        content_format: "markdown",
                        max_depth: 4,
                        max_blocks: 300,
                        page_size: 100
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
