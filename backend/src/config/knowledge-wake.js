import {writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {env} from './env.js';

// Windows의 SQLite mmap/WAL 변경 통지는 보장되지 않는다. 이 파일은 비밀 없는 wake hint일 뿐이다.
// 원문/위키/작업 저장소가 아니며, 수신자는 반드시 DB와 현재 권한을 다시 읽는다.
export const wikiWakePath=()=>env.databaseFile===':memory:'?null:`${path.resolve(env.databaseFile)}.wiki-wake`;
let scheduled=false;
export function signalWikiWrite(){
  if(scheduled)return;scheduled=true;
  // Generic model writes can be inside a synchronous outer role/source transaction.
  // Deliver after that stack commits (or rolls back), never an uncommitted snapshot.
  queueMicrotask(()=>{
    scheduled=false;
    process.emit('orbitflow:wiki-changed',{store:'legacy'});
    const target=wikiWakePath();if(!target)return;
    const temporary=`${target}.${randomUUID()}.tmp`;
    try{writeFileSync(temporary,'{}\n',{flag:'wx',mode:0o600});renameSync(temporary,target);}
    catch(error){console.warn('Wiki wake hint unavailable; authoritative DB checks remain active',error.code ?? error.name);}
    finally{if(existsSync(temporary))unlinkSync(temporary);}
  });
}
