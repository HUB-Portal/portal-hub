import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { config } from '../config';

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize('NFKC'), salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

const R = 8;
const P = 1;
const KEYLEN = 64;

function opts(logN: number): ScryptOptions {
  return { N: 2 ** logN, r: R, p: P, maxmem: 256 * 1024 * 1024 };
}

/** Format: s1$<logN>$<r>$<p>$<salt b64>$<hash b64> */
export async function hashPassword(password: string, logN: number = config.scryptLogN): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, opts(logN));
  return `s1$${logN}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 's1') return false;
  const logN = Number(parts[1]);
  if (!Number.isInteger(logN) || logN < 10 || logN > 22) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, salt, expected.length, { N: 2 ** logN, r: Number(parts[2]), p: Number(parts[3]), maxmem: 256 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** Same cost as a real verification. Used for unknown or unusable accounts so timing does not reveal them. */
export async function dummyVerify(password: string): Promise<false> {
  dummy ??= hashPassword('dummy-password-for-timing-only', config.scryptLogN);
  await verifyPassword(await dummy, password);
  return false;
}

const COMMON = `
password password1 password12 password123 password1234 password12345 passw0rd p@ssw0rd p@ssword pa55word pa55w0rd
123456 1234567 12345678 123456789 1234567890 12345678910 111111 11111111 000000 00000000 121212 123123 123321 654321
qwerty qwerty1 qwerty12 qwerty123 qwertyuiop qwertyuiop1 qwerty12345 asdfgh asdfghjkl asdfghjkl1 zxcvbn zxcvbnm
1q2w3e4r 1q2w3e4r5t 1qaz2wsx 1qaz2wsx3edc qazwsx qazwsxedc zaq12wsx abc123 abc12345 abcd1234 abcdefg abcdefgh
iloveyou iloveyou1 letmein letmein1 welcome welcome1 welcome12 welcome123 admin admin1 admin123 administrator
adminadmin admin1234 root toor login master monkey dragon football baseball basketball soccer hockey
superman batman spiderman starwars pokemon naruto sunshine princess shadow ninja mustang michael jordan
jennifer jessica ashley daniel thomas charlie andrew joshua matthew nicholas hunter freedom whatever
trustno1 trustno1trustno1 changeme changeme1 changeme123 default secret secret123 test test1 test123 test1234
testing testing123 guest guest123 user user123 hello hello123 helloworld hello1234 access flower flowers
lovely loveme love123 lovers passion secure security summer winter spring autumn january february march
april july august september october november december monday tuesday wednesday thursday friday saturday sunday
computer internet google facebook twitter youtube gmail hotmail yahoo outlook microsoft windows windows10
apple iphone samsung android linux ubuntu server database mysql postgres postgres1 oracle office
company company1 business work work123 office123 teamwork manager director employee customer service support
klinepartner klinehub kline123 kline2024 kline2025 kline2026 partnerhub partner123 partnerhub1 aligners aligner1
clearaligner clearaligners dental dentist dentist1 orthodontist smile smile123 teeth teeth123 braces braces1
demo demo123 demo1234 demo2024 demo2025 demo2026 sample sample123 example example1 example123
qwertz qwertz123 qwertzuiop hallo hallo123 passwort passwort1 passwort123 willkommen willkommen1 geheim geheim123
sommer sommer2024 winter2024 winter2025 winter2026 sommer2025 sommer2026 fussball fussball1 schatz schatz123
motdepasse motdepasse1 azerty azerty123 azertyuiop contrasena contrasena1 senha senha123 senha1234
letmein123 letmein2024 iloveyou123 monkey123 dragon123 master123 shadow123 sunshine1 princess1 football1
baseball1 superman1 batman123 starwars1 trustno1! p455w0rd passw0rd1 passw0rd123 password! password. password2024
password2025 password2026 password@123 password#1 pass1234 pass12345 pass123456 qwerty!23 abc@1234 admin@123
welcome@123 welcome2024 welcome2025 welcome2026 spring2024 spring2025 spring2026 autumn2024 autumn2025 autumn2026
january2024 january2025 january2026 changeit changeit123 changethis newpassword newpassword1 newpass123 mypassword
mypassword1 mypassword123 mypass123 yourpassword thisisapassword iamthebest letmeinplease
`;

// A larger list of the most used passwords, names, teams, places, keyboard patterns and words in English, German, French, Spanish and Portuguese.
const COMMON_MORE = `
rockyou nicole babygirl tigger chocolate friends butterfly purple angel liverpool justin secret1 andrea carlos bubbles hannah
amanda loveyou pretty angels tweety playboy elizabeth hottie tinkerbell samantha barbie chelsea teamo jasmine brandon 666666 melissa
eminem robert danielle forever family jonathan 987654321 vanessa cookie sweety spongebob joseph junior softball taylor yellow daniela
lauren mickey princesa alexandra alexis jesus estrella miguel william beautiful mylove angela poohbear patrick iloveme sakura adrian
alexander destiny christian sayang america dancer monica richard 112233 diamond carolina steven rangers louise orange 789456 999999
nathan snoopy gabriel cherry killer sandra alejandro buster george brittany alejandra patricia rachel tequiero 7777777 cheese 159753
arsenal dolphin antonio heather david ginger stephanie peanut blink182 sweetie 222222 beauty 987654 victoria honey fernando maggie
corazon chicken pepper cristina rainbow kisses manuel myspace rebelde ricardo babygurl heaven greenday martin alyssa madison mother
123abc mahalo gfhjkm badboy tiger iloveu1 iloveyou2 princess123 qwerty111 qwerty123456 qwerty1234 qwerty12345678 qwertyuiop123
qwertyuiop1234 qwertyui qwertzui qwertzuiop1 qwertzuiopasdfghjkl asdfghjkl123 asdfghjkl1234 asdfghjk asdfasdf asdfasdfasdf zxcvbnm123
zxcvbnm1234 qazwsx123 qazwsxedc123 qazwsxedcrfv qazxsw 1qazxsw2 1qaz2wsx3edc4rfv 1qaz2wsx3edc4rfv5tgb 1q2w3e 1q2w3e4r5t6y 1q2w3e4r5t6y7u
q1w2e3r4 q1w2e3r4t5 q1w2e3r4t5y6 qweasdzxc qweasd asdasd zxczxc qweqwe qwe123 qwe12345 qwe123qwe asdqwe123 qwerasdf zaq1xsw2 zaq12wsx
a1b2c3 a1b2c3d4 abc123abc abcabc abc1234 abcd123 abcd12345 abcdef abcdef1 abcdef12 abcdef123 abcdefghi abcdefghij abcdefghijk
aaaaaa aaaaaaaa aaa111 aaaa1111 11223344 123456789a 123456a 123456abc 1234qwer 1234abcd 12341234 12121212 123123123
1234512345 0123456789 01234567 0987654321 9876543210 147258369 741852963 159357 1357924680 135792468 24681012 112233445566
147852369 789456123 456789 4567890 321654 321654987 963852741 852456 51505150 1111111111 2222222222 55555555 66666666 77777777 88888888 99999999
passwort12 passwort123 passwort1234 passwort12345 password12 password01 password02 password007 password99 password11 password22 passwordpassword
passw0rd1 passw0rd12 passwd passwd1 passwd123 pass pass1 pass123 pass1word pass2word pass3word p4ssw0rd p4ssword
passcode passphrase secretpassword supersecret superpassword topsecret mysecret mysecret1 mypassword12
masterkey master1 master12 master123 master1234 administrator1 administrator123 admin12345 admin123456 admin2024 admin2025 admin2026
adminadmin1 adminpassword root123 root1234 rootroot rootpassword toor123 superuser sysadmin sysadmin1 operator
login123 login1234 logmein letmein12 letmein1234 letmeinnow openme opensesame open123 opensesame1
welcome1234 welcome12345 welcome2 welcometo willkommen123 hello1 hello12 hello12345 helloworld1 helloworld123 hellohello hallo1234 hallo12345
iloveyou12 iloveyou1234 iloveyou123456 iloveyoutoo ilovemyself ilovemom iloveyousomuch ilovedogs ilovecats ihateyou ihateyou1
loveyou1 loveyou123 loveme1 loveme123 lovelove lovelove1 lovely1 lovelife love1234 love12345 lovers1 ilovejesus jesuschrist godisgood godblessyou
trustnoone 1trustno1 whatever1 whatever123 nothing nothing1 nobody anything anything1 qwertyasdf test12345 test123456 testtest
testing1 testing12 testing1234 tester tester1 tester123 testuser testuser1 guest1 guest12 guest1234 default1 default123 changeme12 changeme1234
changeit1 changepassword newpass newpass1 newpassword12 newpassword123 userpassword user1234 user12345 username username1
football12 football123 football1234 baseball12 baseball123 basketball1 soccer123 soccer1 hockey123 hockey1 tennis golfer golf1234 cricket cricket1 rugby rugby123
manchester manchesterunited chelsea1 chelsea123 arsenal1 arsenal123 liverpool1 liverpool123 barcelona barcelona1 realmadrid realmadrid1 juventus acmilan
bayern bayernmunchen bayern1 bayern123 dortmund borussia schalke04 hannover96 werderbremen fussball12 fussball123 fussballfan
dragon1 dragon12 dragon123 dragon1234 monkey1 monkey12 monkey1234 shadow1 shadow12 shadow1234 master01 sunshine12 sunshine123 princess12 princess1234
superman12 superman123 batman1 batman12 spiderman1 spiderman123 pokemon1 pokemon123 starwars123 harrypotter hogwarts gandalf lordoftherings
mercedes ferrari porsche lamborghini mustang1 corvette harley harley1 yamaha honda toyota nissan chevy bmw123 audi123
january1 february1 march123 april123 may12345 june1234 july1234 august123 september1 october1 november1 december1 summer1 summer12 summer123 summer2024 summer2025 summer2026
winter1 winter12 winter123 winter2023 spring1 spring12 spring123 autumn1 autumn123 herbst herbst123 sommer1 sommer123 winter12345 fruehling
monday1 tuesday1 friday1 sunday1 saturday1 weekend weekend1 holiday holiday1 vacation vacation1 urlaub urlaub123 sonne sonnenschein sonnenschein1
berlin berlin123 hamburg hamburg1 munich munchen paris paris123 london london123 newyork newyork1 amsterdam madrid madrid1 lisboa lisbon cairo cairo123 chaves
germany germany1 deutschland deutschland1 england france espana portugal portugal1 egypt egypt123 mexico mexico123 america1 usa123 canada
company123 company1234 business1 business123 office1 office1234 work1234 workwork working teamwork1 manager1 manager123 director1 secretary1 service1 service123
support1 support123 helpdesk helpdesk1 customer1 client123 partner1 partner12 partner1234 partners partnerhub123 partnerhub2026 kline1 kline12 kline1234 klinepartner1
klinepartner123 klinepartnerhub klinehub1 klinehub123 klineeurope klineeurope1 klineeurope123 klinealigners klinealigner clearx clearx123 clearxaligners clearxaligners1
aligner12 aligners1 aligners123 clearaligner1 clearaligners1 dental1 dental123 dentist12 dentist123 doctor doctor123 orthodontist1 orthodontics ortho123 smile1 smile12 smiles smiley
dentalclinic dentalcare dentalpractice teeth1 teeth12 braces12 invisalign invisalign1 invisible
motdepasse12 motdepasse123 bonjour bonjour123 azerty1 azerty12 azerty1234 azertyuiop1 azertyuiop123 azertyuiopqsdfghjklm contrasena12 contrasena123
hola hola123 hola1234 holamundo amor amor123 teamo123 senha12 senha12345 senhasenha minhasenha ola123 olamundo wachtwoord wachtwoord1 wachtwoord123
sandbox sandbox1 staging staging1 production production1 database1 database123 postgres123 postgres1234 mysql123 oracle123 server123 server1234
google123 gmail123 facebook1 facebook123 twitter1 youtube1 instagram instagram1 whatsapp whatsapp1 windows1 windows123 microsoft1 microsoft123 apple123 iphone123 samsung1
computer1 computer12 computer123 internet1 internet123 laptop laptop123 keyboard keyboard1 monitor mouse login12 online online123 website website1
anonymous anonymous1 hacker hacker123 hackme hackme123 cracker cracker123 secure123 secure1234 security1 security123 protect protected private private1 private123
`;

const normalise = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
const COMMON_SET = new Set([...COMMON.split(/\s+/), ...COMMON_MORE.split(/\s+/)].filter(Boolean).map(normalise));
export const COMMON_PASSWORD_COUNT = COMMON_SET.size;

/** Symbols that stand for letters in "leet" spelling, replaced before the other symbols are dropped. */
const LEET_SYMBOLS: Record<string, string> = { '@': 'a', $: 's', '!': 'i', '+': 't', '|': 'l', '€': 'e', '£': 'e' };
/** Digits that stand for letters. A 1 can be an i or an l, so both are tried. */
const LEET_DIGITS: Record<string, string> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

function leetVariants(s: string): string[] {
  const base = s.replace(/[034578]/g, (d) => LEET_DIGITS[d]!);
  return [...new Set([base.replace(/1/g, 'i'), base.replace(/1/g, 'l')])];
}

/**
 * Every plain form a password can be reduced to before it is looked up in the list of common passwords: lower case, symbols that
 * stand for letters replaced, other symbols and spaces dropped, digits at the end (and at the start) cut off, digits that stand for letters replaced.
 */
function normalisedForms(password: string): Set<string> {
  const lower = password.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  const bases = new Set([
    lower.replace(/[^a-z0-9]/g, ''), // every symbol dropped
    lower.replace(/[@$!+|€£]/g, (c) => LEET_SYMBOLS[c]!).replace(/[^a-z0-9]/g, ''), // every symbol that can stand for a letter replaced
    lower.replace(/[@$]/g, (c) => LEET_SYMBOLS[c]!).replace(/[^a-z0-9]/g, ''), // only @ and $ replaced: P@ssw0rd2026! is password
  ]);
  for (const b of bases) {
    const trimmed = [b, b.replace(/\d+$/, ''), b.replace(/^\d+/, ''), b.replace(/^\d+/, '').replace(/\d+$/, '')];
    for (const t of trimmed) {
      if (!t) continue;
      out.add(t);
      for (const v of leetVariants(t)) out.add(v);
    }
  }
  return out;
}

export function isCommonPassword(password: string): boolean {
  for (const form of normalisedForms(password)) {
    // Stems shorter than 4 characters would match far too much.
    if (form.length >= 4 && COMMON_SET.has(form)) return true;
  }
  return false;
}

const ROWS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', // English
  'qwertzuiop', 'yxcvbnm', // German
  'azertyuiop', 'qsdfghjklm', 'wxcvbn', // French
  '1234567890', '0987654321', // digits
  'qazwsxedcrfvtgbyhnujm', 'zaqxswcdevfrbgtnhymju', // diagonal walks (1qaz2wsx3edc with the digits taken out)
];

/** Four characters in a row that run along the alphabet or the digits (abcd, 4321), or along a keyboard row (qwer, asdf, ytre), in either direction. */
export function hasSequence(password: string): boolean {
  const p = password.normalize('NFKC').toLowerCase();
  // alphabet and digit runs: each next character is one code point up or down, in the same kind (letters or digits)
  let up = 1;
  let down = 1;
  for (let i = 1; i < p.length; i++) {
    const a = p.charCodeAt(i - 1);
    const b = p.charCodeAt(i);
    const same = (a >= 48 && a <= 57 && b >= 48 && b <= 57) || (a >= 97 && a <= 122 && b >= 97 && b <= 122);
    up = same && b === a + 1 ? up + 1 : 1;
    down = same && b === a - 1 ? down + 1 : 1;
    if (up >= 4 || down >= 4) return true;
  }
  // keyboard rows, also with the digits and symbols taken out, so 1qaz2wsx3edc4rfv is seen as qazwsxedcrfv
  const forms = [p, p.replace(/[^a-z]/g, ''), p.replace(/[^a-z0-9]/g, '')];
  for (const f of forms) {
    for (const row of ROWS) {
      const rev = [...row].reverse().join('');
      for (const r of [row, rev]) {
        for (let i = 0; i + 4 <= r.length; i++) {
          const gram = r.slice(i, i + 4);
          // "erty" is inside real words (property, liberty, poverty): only a longer run counts for it
          if (gram === 'erty' || gram === 'ytre') {
            if (f.includes(r.slice(i, i + 5)) && i + 5 <= r.length) return true;
            continue;
          }
          if (f.includes(gram)) return true;
        }
      }
    }
  }
  return false;
}

/** The same character four times in a row, or a short block repeated (abab, Abc1Abc1, xyz123xyz123). */
export function hasRepeats(password: string): boolean {
  const p = password.normalize('NFKC').toLowerCase();
  if (/(.)\1{3,}/u.test(p)) return true;
  if (/(.{2,3})\1{2,}/u.test(p)) return true;
  // the same block three times with separators in between (Kp9vz-Kp9vz-Kp9vz) is seen once the separators are gone
  if (/(.{2,8})\1{2,}/u.test(p.replace(/[^\p{L}\p{N}]/gu, ''))) return true;
  return /^(.{1,8}?)\1+$/u.test(p);
}

/** Number of kinds of characters used: lower case, upper case, digits, anything else. */
function classCount(p: string): number {
  return [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u].filter((r) => r.test(p)).length;
}

export interface PasswordContext {
  email?: string;
  name?: string;
}

const TOO_COMMON = 'That password is too common. Choose something less guessable.';
const TOO_EASY = 'That password follows a pattern that is easy to guess. Try three or four unrelated words instead.';
const TOO_PLAIN = 'Use a longer passphrase of at least 16 characters, or mix capital letters, digits and symbols.';

/** Returns a plain English reason when the password is not acceptable, else null. */
export function checkPasswordPolicy(password: string, ctx: PasswordContext = {}): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use at most 128 characters.';
  if (/^(.)\1+$/.test(password)) return 'Do not repeat one character.';
  if (isCommonPassword(password)) return TOO_COMMON;
  if (hasSequence(password) || hasRepeats(password)) return TOO_EASY;
  if (password.length < 16 && classCount(password) < 2) return TOO_PLAIN;
  const lower = password.toLowerCase();
  if (ctx.email) {
    const local = ctx.email.toLowerCase().split('@')[0];
    if (local.length >= 4 && lower.includes(local)) return 'Do not use your email address in your password.';
  }
  if (ctx.name) {
    for (const part of ctx.name.toLowerCase().split(/[\s.\-_']+/)) {
      if (part.length >= 4 && lower.includes(part)) return 'Do not use your name in your password.';
    }
  }
  return null;
}
