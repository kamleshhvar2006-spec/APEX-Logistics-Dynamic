// Usage:  node tools/make_admin_hash.js "YourStrongPassword"
// Prints the two secret values to paste into the function's environment variables in the Catalyst console.
// Never commit the output to GitHub.
const crypto = require('crypto');

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('Usage: node tools/make_admin_hash.js "<password with at least 10 characters>"');
  process.exit(1);
}
const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);

console.log('\nADMIN_PASSWORD_HASH=scrypt:' + salt.toString('hex') + ':' + hash.toString('hex'));
console.log('SESSION_SECRET=' + crypto.randomBytes(48).toString('hex'));
console.log('\nAlso set ADMIN_EMAIL to the email you will type on the login form.\n');
