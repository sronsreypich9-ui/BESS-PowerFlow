const fs = require('fs');
const path = require('path');
const os = require('os');

const pluginsDir = path.join(os.homedir(), 'AppData', 'Roaming', 'powerflow-toolbox', 'engine', 'plugins');
console.log('Plugins directory path:', pluginsDir);

if (fs.existsSync(pluginsDir)) {
  const files = fs.readdirSync(pluginsDir);
  console.log('Files:', files);
  for (const f of files) {
    if (f.endsWith('.m')) {
      const p = path.join(pluginsDir, f);
      console.log(`\n=== FILE: ${f} ===`);
      const content = fs.readFileSync(p, 'utf8');
      console.log(content.substring(0, 1000));
      console.log('==================\n');
    }
  }
} else {
  console.log('Plugins directory does not exist.');
}
