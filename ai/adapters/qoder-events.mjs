import {randomUUID} from 'node:crypto';
export function qoderEvents(emit) {
  let messageId=randomUUID(), blocks=new Map();
  return m => {
    const e=m.event;
    if(m.type==='stream_event') {
      if(e.type==='message_start'){messageId=e.message?.id || randomUUID();blocks=new Map();}
      if(e.type==='content_block_start') {
        const b=e.content_block;blocks.set(e.index,{...b,streamed:false});
        if(b.type==='thinking')emit({type:'process',id:`${messageId}:${e.index}`,kind:'reasoning',name:'思考',text:b.thinking || ''});
        if(b.type==='tool_use')emit({type:'process',id:b.id,kind:'tool',name:b.name,input:b.input});
      }
      const b=blocks.get(e.index), id=`${messageId}:${e.index}`;
      if(e.type==='content_block_delta') {
        if(e.delta.type==='text_delta'){if(b)b.streamed=true;emit({type:'delta',itemId:id,text:e.delta.text});}
        if(e.delta.type==='thinking_delta'){if(b)b.streamed=true;emit({type:'process',id,kind:'reasoning',name:'思考',textDelta:e.delta.thinking});}
      }
      if(e.type==='content_block_stop' && b?.type==='thinking')emit({type:'process',id,kind:'reasoning',status:'completed'});
    }
    if(m.type==='assistant') {
      (m.message?.content || []).forEach((b,index)=>{
        const id=`${m.message.id || messageId}:${index}`, streamed=blocks.get(index)?.streamed;
        if(b.type==='text' && !streamed)emit({type:'delta',itemId:id,text:b.text});
        if(b.type==='thinking')emit({type:'process',id,kind:'reasoning',name:'思考',text:b.thinking || '',status:'completed'});
        if(b.type==='tool_use')emit({type:'process',id:b.id,kind:'tool',name:b.name,input:b.input});
      });
    }
    if(m.type==='user')for(const b of Array.isArray(m.message?.content)?m.message.content:[])if(b.type==='tool_result')emit({type:'process',id:b.tool_use_id,output:b.content,status:b.is_error?'failed':'completed'});
  };
}
