import { base32Decode, totpCode } from './src/crypto/totp';
import { demoTotpSecret } from './src/services/demo';
const B='http://localhost:4000';
async function session(email:string){ let cookie='',csrf=''; 
  const call=async(m:string,u:string,b?:unknown)=>{const h:Record<string,string>={};if(cookie)h.cookie=cookie;if(csrf)h['x-csrf-token']=csrf;if(b!==undefined)h['content-type']='application/json';const r=await fetch(B+u,{method:m,headers:h,body:b!==undefined?JSON.stringify(b):undefined});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0]!;let j:any=null;const t=await r.text();try{j=JSON.parse(t)}catch{}if(j?.csrfToken)csrf=j.csrfToken;return{s:r.status,j,t}};
  const d=(await call('GET','/api/demo/accounts')).j; await call('POST','/api/auth/login',{email,password:d.password});
  const v=await call('POST','/api/auth/mfa/verify',{code:totpCode(base32Decode(demoTotpSecret(email)),Date.now()/1000)}); return {call,ok:v.s===200}; }
const partner=['/api/org','/api/org/profile','/api/org/onboarding','/api/org/menu','/api/org/agreements','/api/org/sites','/api/org/brands','/api/org/documents','/api/cases?pageSize=25','/api/claims','/api/specs','/api/specs/active','/api/materials','/api/material-shipments','/api/team','/api/audit','/api/notifications','/api/account/notifications','/api/org/bag-layout','/api/auth/sessions','/api/exports/cases.csv?from=2026-01-01&to=2026-12-31','/api/exports/shipments.csv?from=2026-01-01&to=2026-12-31'];
const staff=['/api/console/overview','/api/console/cases','/api/console/claims','/api/console/materials','/api/console/material-shipments','/api/console/specs/partners','/api/intake?tab=review','/api/partners','/api/mes/stage-map','/api/mes/events','/api/service-keys','/api/staff','/api/sites','/api/audit','/api/notifications','/api/audit/verify'];
for (const [email,list] of [['admin@acme.demo',partner],['upload@acme.demo',partner],['quality@acme.demo',partner],['finance@acme.demo',partner],['admin@kline.demo',staff]] as const) {
  const s=await session(email); if(!s.ok){console.log(email,'LOGIN FAILED');continue}
  const bad:string[]=[]; let n=0;
  for(const u of list){ const r=await s.call('GET',u); n++; if(r.s>=400) bad.push(`${u} -> ${r.s} ${r.j?.code??''}`); if(r.s>=500) bad.push('   500 BODY '+r.t.slice(0,120)); }
  console.log(email.padEnd(22), `${n} calls,`, bad.length? 'PROBLEMS:' : 'all fine', bad.join(' | '));
}
process.exit(0);
