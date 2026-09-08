import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer } from "../../backend/tests/http.js";

// 실제 PG 라우트/인증/컨트롤러를 실행하되 SQL만 통제한다. PostgreSQL 실행 증거가 아니다.
export async function startPgGraphFixture() {
  process.env.DATABASE_URL="";process.env.PG_HOST="127.0.0.1";process.env.PG_PORT="1";
  const server=await startTestServer();
  const {pgPool}=await import("../../backend/src/config/pg.js");
  const original=pgPool.query,token=randomUUID(),queries=[];
  const notes=new Map([
    ["1",{id:"1",owner:"101",title:"PG Beta",content_md:"# Beta\n[[PG Gamma]]",folder_path:"/work",version:41}],
    ["2",{id:"2",owner:"101",title:"PG Gamma",content_md:"# Gamma",folder_path:"/ideas",version:42}],
    ["3",{id:"3",owner:"101",title:"PG Island",content_md:"# Alone",folder_path:"/ideas",version:43}],
    ["4",{id:"4",owner:"202",title:"Foreign Note",content_md:"private",folder_path:"/",version:44}],
  ]);
  const sqlRow = row => ({ ...row, version: String(row.version) });
  let nextId=5;
  pgPool.query=async(sql,values=[])=>{
    queries.push({sql,values});
    if(sql.includes("FROM auth.sessions s"))return{rows:values[0]===token?[{id:"101",session_id:"qa-session",company_id:"77",name:"PG QA",email:"qa@example.invalid",account_status:"active",approval_status:"approved",login_at:new Date().toISOString()}]:[]};
    if(sql.includes("FROM org.company_memberships m JOIN org.companies c"))return{rows:values[0]==="101"&&values[1]==="77"?[{user_id:"101",company_id:"77",department_id:null,position_id:null,name:"PG QA Workspace"}]:[]};
    if(sql.includes("FROM org.user_roles"))return{rows:[{code:"agent.chat",role:"member"}]};
    if(sql.includes("FROM org.company_modules"))return{rows:[{module_key:"agent"}]};
    if(sql.includes("FROM org.company_feature_settings"))return{rows:[]};
    if(sql.includes("FROM org.companies"))return{rows:[{name:"PG QA Workspace"}]};
    if(sql.includes("FROM notes.vaults WHERE owner_id"))return{rows:[{id:"12"}]};
    if(sql.includes("INSERT INTO notes.notes")){
      assert.match(sql,/RETURNING.*xmin::text/s);const row={id:String(nextId++),owner:"101",title:values[2],content_md:values[3],folder_path:values[1],version:100+nextId};notes.set(row.id,row);return{rows:[sqlRow(row)],rowCount:1};
    }
    if(sql.includes("UPDATE notes.notes")){
      assert.match(sql,/n\.xmin::text\s*=\s*\$6/);assert.match(sql,/v\.owner_id\s*=\s*\$2/);
      const row=notes.get(String(values[0]));if(!row||row.owner!==values[1]||String(row.version)!==String(values[5]))return{rows:[],rowCount:0};
      if(values[2]!==null)row.title=values[2];if(values[3]!==null)row.content_md=values[3];if(values[4]!==null)row.folder_path=values[4];row.version+=100;return{rows:[sqlRow(row)],rowCount:1};
    }
    if(sql.includes("DELETE FROM notes.notes")){
      assert.match(sql,/v\.owner_id\s*=\s*\$2/);const row=notes.get(String(values[0]));if(!row||row.owner!==values[1])return{rows:[],rowCount:0};notes.delete(row.id);return{rows:[],rowCount:1};
    }
    if(sql.includes("FROM notes.notes n JOIN notes.vaults v")){
      assert.match(sql,/v\.owner_id\s*=\s*\$[12]/);
      if(sql.includes("n.id = $1")){const row=notes.get(String(values[0]));return{rows:row?.owner===values[1]?[sqlRow(row)]:[]};}
      return{rows:[...notes.values()].filter(row=>row.owner===values[0]).slice(0,sql.includes("LIMIT $2")?values[1]:undefined).map(sqlRow)};
    }
    throw new Error(`Unexpected PG graph fixture SQL: ${sql}`);
  };
  return{...server,token,orgId:"pg:77",queries,notes,async close(){pgPool.query=original;await pgPool.end();await server.close();}};
}
