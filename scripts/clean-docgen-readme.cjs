const fs = require('node:fs');

const readmePath = 'README.md';
const readme = fs.readFileSync(readmePath, 'utf8');
fs.writeFileSync(readmePath, readme.replace(/\r/g, ''));
