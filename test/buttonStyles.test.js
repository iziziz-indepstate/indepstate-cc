const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  const placedColor = indexHtml.match(/\.card__status--placed\s*\{\s*background:([^;]+);/)?.[1];
  const activeColor = indexHtml.match(/\.card__status--active\s*\{\s*background:([^;]+);/)?.[1];
  const executingColor = indexHtml.match(/\.card__status--executing\s*\{\s*background:([^;]+);/)?.[1];
  assert.strictEqual(placedColor, '#f59e0b');
  assert.strictEqual(activeColor, '#3b82f6');
  assert.strictEqual(executingColor, '#3b82f6');
  assert.notStrictEqual(placedColor, executingColor);
  console.log('buttonStyles test passed');
}

run();
