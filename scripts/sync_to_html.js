// sync_to_html.js - lane_matchups.json の内容を index.html の LANE_MATCHUPS に同期する
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const dataPath = path.join(__dirname, '..', 'src', 'data', 'lane_matchups.json');

const html = fs.readFileSync(htmlPath, 'utf-8');
const matchups = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

// Build JS object
let js = 'const LANE_MATCHUPS = {\n';
const lanes = Object.keys(matchups);
for (let li = 0; li < lanes.length; li++) {
  const lane = lanes[li];
  const entries = matchups[lane];
  const keys = Object.keys(entries);
  js += '  ' + lane + ': {\n';
  for (let ki = 0; ki < keys.length; ki++) {
    const k = keys[ki];
    const v = entries[k];
    js += '    ' + JSON.stringify(k) + ': { result:' + JSON.stringify(v.result) +
          ', tips:' + JSON.stringify(v.tips) +
          ', keyPoints:' + JSON.stringify(v.keyPoints) + ' }';
    if (ki < keys.length - 1) js += ',';
    js += '\n';
  }
  js += '  }';
  if (li < lanes.length - 1) js += ',';
  js += '\n';
}
js += '};';

// Find and replace
const startMarker = 'const LANE_MATCHUPS = {';
const startIdx = html.indexOf(startMarker);
if (startIdx === -1) { console.error('LANE_MATCHUPS not found in index.html'); process.exit(1); }

let braceCount = 0, endIdx = -1;
for (let i = startIdx + startMarker.length - 1; i < html.length; i++) {
  if (html[i] === '{') braceCount++;
  if (html[i] === '}') braceCount--;
  if (braceCount === 0) { endIdx = i + 1; break; }
}
if (html[endIdx] === ';') endIdx++;

const newHtml = html.substring(0, startIdx) + js + html.substring(endIdx);
fs.writeFileSync(htmlPath, newHtml, 'utf-8');

console.log('Synced LANE_MATCHUPS to index.html:');
lanes.forEach(l => console.log(`  ${l}: ${Object.keys(matchups[l]).length} entries`));
