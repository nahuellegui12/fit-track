import { copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const requiredFiles = [
  'dist/index.html',
  'dist/manifest.webmanifest',
  'dist/service-worker.js',
];

await Promise.all(requiredFiles.map((file) => access(file, constants.R_OK)));
await copyFile('assets/icon.png', 'dist/fittrack-icon.png');

console.log('Web PWA assets prepared in dist/.');
