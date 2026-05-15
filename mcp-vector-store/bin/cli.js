const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log('js-vector-store-headless CLI');
  console.log('');
  console.log('Usage: js-vector-store-headless <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  api           Start the vector search REST API server');
  console.log('  mcp           Start the MCP Vector Store server');
  console.log('  list          List collections');
  console.log('  embed         Generate embedding for a text via Ollama');
  console.log('  help          Show this help');
  console.log('');
  console.log('Options:');
  console.log('  --port, -p    Port for API server (default: 3000)');
  console.log('  --data, -d    Data directory (default: ./vector-data)');
  console.log('  --model, -m   Ollama embedding model (default: embeddinggemma:latest)');
}

if (!command || command === 'help' || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

const portIndex = args.indexOf('--port') !== -1 ? args.indexOf('--port') : args.indexOf('-p');
const dataIndex = args.indexOf('--data') !== -1 ? args.indexOf('--data') : args.indexOf('-d');
const modelIndex = args.indexOf('--model') !== -1 ? args.indexOf('--model') : args.indexOf('-m');

if (portIndex !== -1) process.env.PORT = args[portIndex + 1];
if (dataIndex !== -1) process.env.DATA_DIR = args[dataIndex + 1];
if (modelIndex !== -1) process.env.OLLAMA_MODEL = args[modelIndex + 1];

const serverDir = path.join(__dirname, '..');

if (command === 'api') {
  require(path.join(serverDir, 'vector-api-server.js'));
} else if (command === 'mcp') {
  require(path.join(serverDir, 'vector-store-server.js'));
} else if (command === 'list') {
  const { VectorStore, FileStorageAdapter } = require(path.join(serverDir, 'js-vector-store.js'));
  const dataDir = process.env.DATA_DIR || path.join(serverDir, 'vector-data');
  if (!fs.existsSync(dataDir)) {
    console.log('No data directory found.');
    process.exit(0);
  }
  const entries = fs.readdirSync(dataDir).filter(f => fs.statSync(path.join(dataDir, f)).isDirectory());
  console.log('Collections: ' + entries.length);
  for (const e of entries) {
    console.log('  - ' + e);
  }
} else if (command === 'embed') {
  const text = args[1];
  if (!text) {
    console.log('Usage: js-vector-store-headless embed "your text here"');
    process.exit(1);
  }
  const model = process.env.OLLAMA_MODEL || 'embeddinggemma:latest';
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  fetch(host + '/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  }).then(async r => {
    const json = await r.json();
    console.log('Dimension: ' + json.embedding.length);
    console.log('First 5: ' + json.embedding.slice(0, 5).join(', '));
  }).catch(console.error);
} else {
  console.log('Unknown command: ' + command);
  showHelp();
  process.exit(1);
}