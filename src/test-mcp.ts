import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

async function main() {
    const notionApiKey = process.env.NOTION_API_KEY;
    if (!notionApiKey) {
        console.error("NOTION_API_KEY is not set in .env");
        process.exit(1);
    }

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
        { name: "notion-trust-agent-test", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    console.log("Connecting to MCP Notion server...");
    await client.connect(transport);
    console.log("Connected successfully!");

    console.log("Calling notion_find tool...");
    try {
        const result = await client.callTool({
            name: "notion_find",
            arguments: {
                query: "",
                type: "page"
            }
        });
        
        console.log("Search Result:");
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error calling tool:", e);
    } finally {
        await transport.close();
    }
}

main().catch(console.error);
