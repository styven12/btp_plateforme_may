const crypto = require('crypto');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function checkPw(user, pw) {
  const a = Buffer.from(hashPw(pw, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// METS ICI ce que tu as dans ta base pour admin
const userFromDb = {
  salt: '4418c945fb6d5a87873dbbfcbf82aea8',
  hash: 'd482ba86ab4b68734630c7ccfffe2b0772ce70dab296c97b2119ac62a7438f80a5a9c6a89e29bbfca6203c3d38b370c93c50c608770ae69dc5f62b575cf38c7f'
};

const passwordTeste = 'Admin';

console.log('Test:', checkPw(userFromDb, passwordTeste) ? 'OK MOT DE PASSE VALIDE' : 'REFUSE');