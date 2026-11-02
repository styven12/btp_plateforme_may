const crypto = require('crypto');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

const newPassword = 'Admin';
const newSalt = crypto.randomBytes(16).toString('hex'); // 32 caractères

console.log('salt:', newSalt);
console.log('hash:', hashPw(newPassword, newSalt));
console.log('password:', newPassword);