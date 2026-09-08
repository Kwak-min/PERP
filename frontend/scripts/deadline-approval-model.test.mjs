import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('approval amounts use submitted decimal strings and only safe legacy integer minor units',async()=>{
  assert.equal(process.env.DEADLINE_ISOLATED,'1');
  const vite=await createServer({configFile:false,root:fileURLToPath(new URL('../',import.meta.url)),envDir:process.env.DEADLINE_TEMP_ROOT,server:{middlewareMode:true,watch:null}});
  try {
    const {exactAmount,detailSchema}=await vite.ssrLoadModule('/src/screens/approvals/model.ts');
    const legacy={form_snapshot:null,body:null};
    assert.equal(exactAmount({...legacy,amount:Number.MAX_SAFE_INTEGER}),'90071992547409.91');
    assert.equal(exactAmount({...legacy,amount:100000000}),'1000000.00');
    assert.equal(exactAmount({...legacy,amount:1}),'0.01');
    assert.equal(exactAmount({...legacy,amount:0}),'0.00');
    for(const amount of [Number.MAX_SAFE_INTEGER+1,1.1,-1,NaN,Infinity]) assert.equal(exactAmount({...legacy,amount}),null);
    assert.equal(exactAmount({...legacy,body:{amount_krw:'9007199254740991.23'},amount:1}),'9007199254740991.23');
    assert.equal(exactAmount({form_snapshot:{fields:[{key:'quoted_total',type:'krw'}]},body:{quoted_total:'1000000.01'}}),'1000000.01');
    const detail={id:'9007199254740993',requester_id:'9007199254740995',title:'',form_key:'generic',body:{},status:'draft',version:7,form_snapshot:null,attachment_snapshot:[],predecessor_id:null};
    assert.equal(detailSchema.parse(detail).id,detail.id);
    for(const version of ['7',0,1.1,Number.MAX_SAFE_INTEGER+1]) assert.equal(detailSchema.safeParse({...detail,version}).success,false);
  } finally { await vite.close(); }
});
