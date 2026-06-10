const fs = require('fs');
const path = require('path');

const apiUrl = process.env['API_URL'] || 'http://localhost:5000';

const dir = path.join(__dirname, '..', 'src', 'environments');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'environment.ts'), `export const environment = {
  production: false,
  apiUrl: 'http://localhost:5000'
};
`);

fs.writeFileSync(path.join(dir, 'environment.prod.ts'), `export const environment = {
  production: true,
  apiUrl: '${apiUrl}'
};
`);

console.log(`environment.prod.ts generado con apiUrl: ${apiUrl}`);
