import test from 'node:test';
import assert from 'node:assert/strict';
import {segmentedControl,segmentKeyboardValue,setSegmentedValue,mountSegmentedControl} from '../public/components/segmented-control.js';

function fixture(role='radiogroup') {
  let focused;
  const listeners = new Map(), group = {
    contains: button => group.buttons.includes(button),
    getAttribute: name => name==='role'?role:undefined,
    querySelectorAll: () => group.buttons,
    addEventListener(type, handler, {signal}) { listeners.set(type,handler);signal.addEventListener('abort',()=>listeners.delete(type)); },
    emit(type, button, key) { let prevented=false;listeners.get(type)?.({target:button,key,preventDefault(){prevented=true;}});return prevented; }
  };
  group.buttons = ['a','b','c','d'].map(value => ({
    dataset:{segmentValue:value},hidden:false,disabled:false,attributes:{},tabIndex:-1,
    closest(selector) { return selector==='.ui-segmented'?group:selector==='[hidden]'?(this.hidden?this:null):this; },
    setAttribute(name,value){this.attributes[name]=value;},focus(){focused=this;}
  }));
  return {group,get focused(){return focused;}};
}
test('default segmented controls retain radio semantics; tab mode associates stable panel IDs',()=>{
  const options=[{value:'a',label:'全部',id:'tab-a',controls:'panel-a'},{value:'b',label:'隐藏',hidden:true},{value:'c',label:'第三项'}];
  const radio=segmentedControl({id:'status',label:'任务状态',value:'a',options});
  assert.match(radio,/role="radiogroup"/);assert.match(radio,/role="radio" aria-checked="true"/);assert.doesNotMatch(radio,/aria-selected|aria-controls/);
  const tabs=segmentedControl({id:'tabs',label:'来源',value:'b',options,mode:'tabs',className:'proxy-tabs'});
  assert.match(tabs,/class="ui-segmented proxy-tabs"/);assert.match(tabs,/role="tablist"/);
  assert.match(tabs,/id="tab-a" role="tab" aria-selected="true" aria-controls="panel-a" tabindex="0"/);
  assert.match(tabs,/aria-selected="false" tabindex="-1" data-segment-value="b" hidden/);assert.doesNotMatch(tabs,/aria-checked/);
});
test('radio keyboard selection still wraps, updates checked state and moves focus',()=>{
  const f=fixture(),changes=[];setSegmentedValue(f.group,'a');const dispose=mountSegmentedControl(f.group,{onChange:value=>changes.push(value)});
  assert.equal(f.group.emit('keydown',f.group.buttons[0],'ArrowLeft'),true);
  assert.equal(f.focused.dataset.segmentValue,'d');assert.deepEqual(changes,['d']);
  assert.equal(f.group.buttons.filter(button=>button.tabIndex===0).length,1);assert.equal(f.group.buttons[3].attributes['aria-checked'],'true');
  dispose();f.group.emit('click',f.group.buttons[0]);assert.deepEqual(changes,['d']);
});
test('tab keyboard and clicks skip hidden and disabled options and keep one roving focus target',()=>{
  const f=fixture('tablist'),changes=[];f.group.buttons[1].hidden=true;f.group.buttons[2].disabled=true;
  setSegmentedValue(f.group,'a');mountSegmentedControl(f.group,{onChange:value=>changes.push(value)});
  f.group.emit('keydown',f.group.buttons[0],'ArrowRight');assert.equal(f.focused,f.group.buttons[3]);
  assert.equal(f.group.buttons[3].attributes['aria-selected'],'true');assert.equal(f.group.buttons[0].attributes['aria-selected'],'false');
  assert.equal(f.group.buttons[3].attributes['aria-checked'],undefined);
  f.group.emit('click',f.group.buttons[1]);f.group.emit('click',f.group.buttons[2]);assert.deepEqual(changes,['d']);
  f.group.emit('keydown',f.group.buttons[3],'Home');assert.equal(f.focused,f.group.buttons[0]);
  f.group.buttons[0].hidden=true;assert.equal(setSegmentedValue(f.group,'a'),'d');
  assert.deepEqual(f.group.buttons.map(button=>button.tabIndex),[-1,-1,-1,0]);
});
test('shared keyboard ordering handles unavailable selections, empty groups and unrelated keys',()=>{
  const options=[{value:'a',hidden:true},{value:'b',disabled:true},{value:'c'},{value:'d'}];
  assert.equal(segmentKeyboardValue(options,'a','ArrowRight'),'c');assert.equal(segmentKeyboardValue(options,'c','ArrowLeft'),'d');
  assert.equal(segmentKeyboardValue(options,'c','End'),'d');assert.equal(segmentKeyboardValue([],undefined,'Home'),undefined);assert.equal(segmentKeyboardValue(options,'c','Enter'),undefined);
});
