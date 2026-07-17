import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'witshift-weather', version: '1.0.0' });

server.registerTool(
  'get_forecast',
  {
    description: 'Return a deterministic demonstration forecast',
    inputSchema: { city: z.string() },
    outputSchema: { forecast: z.string() },
  },
  ({ city }) => ({
    content: [{ type: 'text', text: `Sunny in ${city}` }],
    structuredContent: { forecast: `Sunny in ${city}` },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
