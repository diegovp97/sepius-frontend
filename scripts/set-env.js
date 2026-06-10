const fs = require('fs');
const path = require('path');

const apiUrl = process.env['API_URL'] || 'http://localhost:5000';

const content = `export const environment = {
  production: true,
  apiUrl: '${apiUrl}'
};
`;

const dir = path.join(__dirname, '..', 'src', 'environments');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, 'environment.prod.ts'), content);
console.log(`environment.prod.ts generado con apiUrl: ${apiUrl}`);
