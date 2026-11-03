import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyLibrary, chatReference} from '../library-data.js';
import {changeLibrary} from '../library-operations.js';
import {buildQuietFolderSections, FOLDER_DRAWER_PAGE_SIZE} from '../quiet-folders.js';

const scope='character:hero.png';
const buildings=[
    {id:'shared',name:'같은 파일',lastActivity:100,count:4},
    {id:'moon',name:'달의 이야기',lastActivity:500,count:8},
    {id:'sun',name:'해의 이야기',lastActivity:200,count:3},
];
test('all/favorites/every folder/unfiled are independently expandable projections',()=>{
    let library=emptyLibrary();
    library=changeLibrary(library,{kind:'folder',type:'create',id:'f1',name:'진행 중'});
    library=changeLibrary(library,{kind:'folder',type:'create',id:'f2',name:'완성'});
    library=changeLibrary(library,{kind:'chat',type:'folder',reference:chatReference(scope,'shared'),value:'f1'});
    library=changeLibrary(library,{kind:'chat',type:'folder',reference:chatReference(scope,'moon'),value:'f1'});
    library=changeLibrary(library,{kind:'chat',type:'favorite',reference:chatReference(scope,'moon'),value:true});
    library=changeLibrary(library,{kind:'chat',type:'favorite',reference:chatReference(scope,'sun'),value:true});
    const before=JSON.stringify(library);
    const sections=buildQuietFolderSections(buildings,scope,library);
    assert.deepEqual(sections.map(s=>[s.key,s.items.length]),[
        ['all',3],['favorites',2],['folder:f1',2],['folder:f2',0],['unfiled',1],
    ]);
    assert.deepEqual(sections[2].items.map(x=>x.id),['moon','shared'],
        'Each folder sorts by most recent chat activity');
    assert.deepEqual(sections[1].items.map(x=>x.id),['moon','sun']);
    assert.equal(sections[2].items[0].name,'달의 이야기','real filename stays unchanged');
    assert.equal(JSON.stringify(library),before,'folder viewing must not persist changes');
});

test('identical filenames in other groups/characters do not leak folder membership',()=>{
    let library=emptyLibrary();
    library=changeLibrary(library,{kind:'folder',type:'create',id:'f1',name:'작업'});
    library=changeLibrary(library,{kind:'chat',type:'folder',reference:chatReference('group:77','shared'),value:'f1'});
    const current=buildQuietFolderSections(buildings,scope,library);
    assert.equal(current[2].items.length,0);
    assert.equal(current.at(-1).items.length,3);
    const group=buildQuietFolderSections(buildings,'group:77',library);
    assert.equal(group[2].items.length,1);
    assert.equal(group[2].items[0].id,'shared');
});

test('large folder previews support a fixed 30-chat page instead of full DOM expansion',()=>{
    const data=emptyLibrary();
    const thousand=Array.from({length:1000},(_,i)=>({
        id:'item-'+i,name:'Chat '+i,lastActivity:1000-i,count:2,
    }));
    const sections=buildQuietFolderSections(thousand,scope,data);
    assert.equal(FOLDER_DRAWER_PAGE_SIZE,30);
    assert.equal(sections.find(s=>s.key==='all').items.length,1000);
    assert.equal(sections.find(s=>s.key==='unfiled').items.length,1000);
    assert.equal(sections.find(s=>s.key==='favorites').items.length,0);
});
