import test from 'node:test';
import assert from 'node:assert/strict';
import {previewSwipes, withQuietPreview, messageTooltipText, QUIET_DETAIL_HEIGHT,
    isValidSwipeSelection} from '../quiet-preview.js';
import {parseExtensionVersion, EXTENSION_FOLDER, EXTENSION_VERSION} from '../update-ui.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

test('full swipe text stays intact, only tooltip excerpt is truncated',()=>{
    const text='가'.repeat(5000);
    const message={mes:text,swipes:[text,'나'.repeat(3000)],swipe_id:1};
    assert.equal(previewSwipes(message).texts[0].length,5000);
    assert.equal(previewSwipes(message).texts[1].length,3000);
    assert.equal(previewSwipes(message).selected,1);
    assert.equal(messageTooltipText(message).length,681);
    assert.equal(messageTooltipText(message).endsWith('…'),true);
    assert.equal(messageTooltipText({mes:'짧음'}),'짧음');
    assert.equal(isValidSwipeSelection(message,1),true);
    assert.equal(isValidSwipeSelection(message,2),false);
    assert.equal(isValidSwipeSelection(message,-1),false);
});

test('inline preview uses exactly one extra virtual row, preserving sorted positions',()=>{
    const row=(index,top)=>({kind:'message',entry:{index},top,height:68});
    const initial=[row(3,0),row(4,68),row(5,136)];
    const changed=withQuietPreview(initial,4);
    assert.equal(changed.present,true);
    assert.equal(changed.totalHeight,QUIET_DETAIL_HEIGHT);
    assert.equal(changed.rows.length,4);
    assert.equal(changed.rows[2].kind,'preview');
    assert.equal(changed.rows[2].top,136);
    assert.equal(changed.rows[3].top,136+QUIET_DETAIL_HEIGHT);
    assert.equal(initial[2].top,136,'original layout must not be modified');
    assert.equal(withQuietPreview(initial,66).present,false);
    assert.equal(withQuietPreview(initial,null).rows.length,3);
});

test('extension updater uses ST Git status, not invented semver comparisons',()=>{
    assert.equal(EXTENSION_FOLDER,'ST-Message-Navigator');
    const path=fileURLToPath(new URL('../manifest.json',import.meta.url));
    assert.equal(JSON.parse(readFileSync(path,'utf8')).version,EXTENSION_VERSION);
    assert.deepEqual(parseExtensionVersion({
        isUpToDate:false,currentBranchName:'main',currentCommitHash:'0123456789abcdef',
        remoteUrl:'https://github.com/user/repo.git',
    }),{isUpToDate:false,branch:'main',commit:'0123456789ab',remote:'https://github.com/user/repo.git'});
    assert.throws(()=>parseExtensionVersion({isUpToDate:false}),/Git/);
    assert.throws(()=>parseExtensionVersion({isUpToDate:'false'}),/응답/);
});
