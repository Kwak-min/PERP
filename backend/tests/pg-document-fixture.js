import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { startTestServer } from './http.js';

// Only authentication is simulated here. Document SQL, identity allocation, FKs,
// transactions and the catalog execute against the shipped PostgreSQL table DDL.
export async function startPgDocumentFixture() {
  process.env.DATABASE_URL=''; process.env.PG_HOST='127.0.0.1'; process.env.PG_PORT='1';
  const uploadRoot=path.join(tmpdir(),`orbitflow-pg-documents-${randomUUID()}`);
  process.env.ORBITFLOW_UPLOAD_DIR=uploadRoot;
  const server=await startTestServer();
  const {pgPool}=await import('../src/config/pg.js');
  const originalQuery=pgPool.query, originalConnect=pgPool.connect;
  const actors={writer:{token:randomUUID(),userId:'101',companyId:'77',orgId:'pg:77'},reader:{token:randomUUID(),userId:'102',companyId:'77',orgId:'pg:77'},foreign:{token:randomUUID(),userId:'201',companyId:'88',orgId:'pg:88'}};
  const sessions=new Map(Object.values(actors).map(actor=>[actor.token,{id:actor.userId,session_id:randomUUID(),company_id:actor.companyId,name:`PG ${actor.userId}`,email:`${actor.userId}@example.invalid`,account_status:'active',approval_status:'approved',login_at:new Date().toISOString()}]));
  const engine=new PGlite();
  await engine.exec(`CREATE SCHEMA org; CREATE SCHEMA auth; CREATE SCHEMA project; CREATE SCHEMA files;
    CREATE TABLE org.companies(id bigint PRIMARY KEY); INSERT INTO org.companies VALUES(77),(88);
    CREATE TABLE auth.users(id bigint PRIMARY KEY); INSERT INTO auth.users VALUES(101),(102),(201);
    CREATE TABLE org.departments(id bigint PRIMARY KEY); CREATE TABLE org.teams(id bigint PRIMARY KEY);`);
  const schema=await readFile(new URL('../../db/perp_schema.sql',import.meta.url),'utf8');
  const corrections=await readFile(new URL('../../db/perp_additions_v9_daily_corrections.sql',import.meta.url),'utf8');
  for (const [source,marker] of [[schema,'CREATE TABLE files.objects ('],[schema,'CREATE TABLE project.projects ('],[schema,'CREATE TABLE project.documents ('],[corrections,'CREATE TABLE IF NOT EXISTS org.daily_correction_events (']]) {
    const start=source.indexOf(marker); if(start<0) throw new Error(`Missing shipped DDL: ${marker}`);
    await engine.exec(source.slice(start,source.indexOf('\n);',start)+3));
  }
  await engine.exec(await readFile(new URL('../../db/perp_additions_v24_workspace_documents.sql',import.meta.url),'utf8'));
  await engine.exec(`INSERT INTO project.projects(id,company_id,name) OVERRIDING SYSTEM VALUE VALUES(10,77,'출시 프로젝트'),(11,77,'운영 프로젝트'),(20,88,'외부 프로젝트');
    INSERT INTO project.documents(project_id,title,content_md,author_id) VALUES(10,'출시 안내서','SYNTH_RELATED pglaunch',101),(11,'점심 메뉴','SYNTH_IRRELEVANT noodles',101),(20,'외부 문서','SYNTH_RELATED FOREIGN_PG_DOCUMENT_ONLY',201);`);
  const queries=[];
  let state;
  const nativeRows=result=>result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value!=null&&result.fields.find(field=>field.name===key)?.dataTypeID===20?String(value):value])));
  const refresh=async()=>{state={projects:nativeRows(await engine.query('SELECT * FROM project.projects ORDER BY id')),documents:nativeRows(await engine.query('SELECT * FROM workspace.document_catalog WHERE deleted_at IS NULL ORDER BY id')),files:nativeRows(await engine.query('SELECT * FROM files.objects ORDER BY id'))};};
  await refresh();
  const execute=async(sql,values=[])=>{
    queries.push({sql:sql.replace(/\s+/g,' ').trim(),values});
    const result=await engine.query(sql,values);await refresh();
    return {...result,rows:nativeRows(result),rowCount:result.rowCount ?? result.affectedRows ?? result.rows.length};
  };
  let tail=Promise.resolve();
  const acquire=async()=>{const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return release;};
  function identity(sql,values) {
    if(sql.includes('FROM auth.sessions s')) return {rows:sessions.has(values[0])?[sessions.get(values[0])]:[]};
    if(sql.includes('FROM org.company_memberships m JOIN org.companies c')) {
      const session=[...sessions.values()].find(row=>row.id===values[0]);
      return {rows:session&&(!values[1]||session.company_id===values[1])?[{user_id:session.id,company_id:session.company_id,department_id:null,position_id:null,name:`Company ${session.company_id}`}]:[]};
    }
    if(sql.startsWith('SELECT DISTINCT p.code')) return {rows:(values[0]===actors.reader.userId?['document.read']:['document.read','document.write']).map(code=>({code,role:values[0]===actors.reader.userId?'reader':'writer'}))};
    if(sql.includes('FROM org.company_modules')) return {rows:[{module_key:'documents'}]};
    if(sql.includes('FROM org.company_feature_settings')) return {rows:[]};
    return null;
  }
  pgPool.query=async(sql,values=[])=>{
    const auth=identity(sql.replace(/\s+/g,' ').trim(),values);if(auth)return auth;
    const release=await acquire();try{return await execute(sql,values);}finally{release();}
  };
  pgPool.connect=async()=>{const release=await acquire();return {query:execute,release};};
  return {...server,actors,queries,uploadRoot,engine,get state(){return state;},async close(){
    pgPool.query=originalQuery;pgPool.connect=originalConnect;await pgPool.end();await engine.close();await server.close();
    await rm(uploadRoot,{recursive:true,force:true});delete process.env.ORBITFLOW_UPLOAD_DIR;
  }};
}
