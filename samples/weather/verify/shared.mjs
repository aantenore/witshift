export function createForecastAdapter(id) {
  return {
    id,
    evidenceLevel: 'test-only',
    async invoke(tool, input) {
      if (tool !== 'get_forecast') throw new Error(`Unknown tool ${tool}`);
      const forecast = `Sunny in ${input.city}`;
      return {
        content: [{ type: 'text', text: forecast }],
        structuredContent: { forecast },
      };
    },
  };
}
