const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'src', 'data', 'lane_matchups.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

// Read all patch files from scripts/patches directory
const patchDir = path.join(__dirname, 'patches');
if (!fs.existsSync(patchDir)) {
  fs.mkdirSync(patchDir, { recursive: true });
}

const patchFiles = fs.readdirSync(patchDir).filter(f => f.endsWith('.json')).sort();
let totalAdded = 0;

for (const file of patchFiles) {
  const patch = JSON.parse(fs.readFileSync(path.join(patchDir, file), 'utf-8'));
  for (const lane of Object.keys(patch)) {
    if (!data[lane]) data[lane] = {};
    for (const key of Object.keys(patch[lane])) {
      if (!data[lane][key]) {
        data[lane][key] = patch[lane][key];
        totalAdded++;
      }
    }
  }
  console.log(`Applied patch: ${file}`);
}

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
console.log(`Total matchups added: ${totalAdded}`);
console.log('Matchup counts per lane:');
for (const lane of ['TOP', 'JG', 'MID', 'ADC', 'SUP']) {
  console.log(`  ${lane}: ${Object.keys(data[lane] || {}).length}`);
}
