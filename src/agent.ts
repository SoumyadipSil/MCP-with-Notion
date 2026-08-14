import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import path from "path";
import axios from "axios";

dotenv.config();

async function main() {
    // 1. Parse CLI arguments
    const question = process.argv.slice(2).join(" ");
    if (!question) {
        console.error("Usage: npx tsx src/agent.ts <your question>");
        process.exit(1);
    }

    const notionApiKey = process.env.NOTION_API_KEY;
    const openRouterApiKey = process.env.OPENROUTER_API_KEY;

    if (!notionApiKey || !openRouterApiKey) {
        console.error("Please set NOTION_API_KEY and OPENROUTER_API_KEY in .env");
        process.exit(1);
    }

    // 2. Setup MCP Client for Notion
    const serverPath = path.resolve(__dirname, "../mcp-notion-server/build/index.js");
    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
        env: {
            ...process.env,
            NOTION_API_TOKEN: notionApiKey
        }
    });

    const client = new Client(
        { name: "notion-trust-agent", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    await client.connect(transport);
    console.log(`\n🔍 Searching Notion for: "${question}"...`);

    try {
        // Find relevant pages
        const findResult = await client.callTool({
            name: "notion_find",
            arguments: {
                query: question,
                type: "page" // Only look for pages
            }
        });

        // The tool returns text in the content array in MCP
        const mcpContent = findResult.content as any[];
        const searchDataText = mcpContent.find(c => c.type === 'text')?.text || '[]';
        const searchData = JSON.parse(searchDataText);
        
        let contextContent = "";
        
        // Take top 3 pages found
        const topPages = searchData.results?.slice(0, 3) || [];
        
        if (topPages.length === 0) {
            console.log("No relevant pages found in Notion.");
            process.exit(0);
        }

        console.log(`📚 Found ${topPages.length} relevant page(s). Fetching content...`);
        
        // Retrieve content for each page
        for (const page of topPages) {
            try {
                const readResult = await client.callTool({
                    name: "notion_read_page",
                    arguments: {
                        page_id: page.id
                    }
                });
                
                const readContent = readResult.content as any[];
                const pageText = readContent.find(c => c.type === 'text')?.text || '';
                
                contextContent += `\n\n--- Page: ${page.title || page.id} ---\n${pageText}`;
            } catch (err) {
                console.error(`Failed to read page ${page.id}`, err);
            }
        }

        console.log(`\n🧠 Sending context to OpenRouter...`);

        // 3. Send to OpenRouter LLM with Confidence Prompts
        const systemPrompt = `
You are a helpful assistant. Use the following context retrieved from the user's Notion workspace to answer their question. 
If the answer is not in the context, say you don't know based on the provided documents.

Context:
${contextContent}

You MUST return your response as a valid JSON object in the exact following format:
{
  "answer": "your detailed answer here",
  "sources_agree": true or false,
  "confidence_reasoning": "explain why the sources agree or disagree and if the information seems sufficient"
}
`;

        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "nvidia/nemotron-3-super-120b-a12b:free",
                response_format: { type: "json_object" }, // Ask OpenRouter for JSON format
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: question }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${openRouterApiKey}`,
                    "Content-Type": "application/json"
                }
            }
        );

        // 4. Calculate Confidence & Print the answer
        let parsedResponse: any = {};
        const llmContent = response.data.choices[0].message.content;
        
        try {
            // Strip any markdown json blocks if they exist
            const cleanLlmContent = llmContent.replace(/```json/g, '').replace(/```/g, '').trim();
            parsedResponse = JSON.parse(cleanLlmContent);
        } catch (e) {
            console.error("Failed to parse LLM JSON response:", llmContent);
            parsedResponse = { answer: llmContent, sources_agree: true, confidence_reasoning: "Failed to parse JSON." };
        }

        // Confidence Logic
        let confidenceLabel = "High confidence";
        
        if (topPages.length === 0) {
            confidenceLabel = "Insufficient data";
        } else if (topPages.length === 1) {
             confidenceLabel = "Medium confidence (Only 1 source found)";
        } else {
             // Check if LLM found conflicts
             if (!parsedResponse.sources_agree) {
                  confidenceLabel = "Conflicting sources";
             }
        }

        console.log("\n=========================================");
        console.log(`✨ ANSWER [${confidenceLabel}]`);
        console.log("=========================================\n");
        console.log(parsedResponse.answer);
        console.log("\n---");
        console.log(`🔍 Confidence Reasoning: ${parsedResponse.confidence_reasoning}`);
        console.log("=========================================");

    } catch (e) {
        console.error("Error during execution:", e);
    } finally {
        await transport.close();
    }
}

main().catch(console.error);
