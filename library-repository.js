/** SillyTavern adapter: library metadata only, lazily accessed on user action. */
import { changeLibrary, moveLibraryReference, forgetLibraryReference, bulkChangeLibrary, cloneLibraryReference } from './library-operations.js';
import { buildingScope } from './building-data.js';
import {
    LIBRARY_KEY, validateLibrary, mergeLibrary, librarySummary,
} from './library-data.js';

export class LibraryRepository {
    constructor(contextProvider) {
        this.contextProvider = contextProvider;
    }

    settingsRoot() {
        const ctx = this.contextProvider();
        if (!ctx?.extensionSettings || typeof ctx.extensionSettings !== 'object') {
            throw new Error('SillyTavern 확장 설정 저장소를 사용할 수 없습니다.');
        }
        return ctx;
    }

    read() {
        const ctx = this.settingsRoot();
        // Never insert a blank namespace on extension load or on a read.
        return validateLibrary(ctx.extensionSettings[LIBRARY_KEY]);
    }

    inspect() {
        // Raises an error for malformed data instead of overwriting it.
        return librarySummary(this.read());
    }

    /**
     * Commit a single requested change. Parse and validate before write;
     * never overwrite an invalid/future schema or unrelated extension keys.
     */
    update(action) {
        const ctx = this.settingsRoot();
        if (typeof ctx.saveSettingsDebounced !== 'function') {
            throw new Error('SillyTavern 설정 저장 함수를 사용할 수 없습니다.');
        }
        const settings = ctx.extensionSettings;
        const previous = settings[LIBRARY_KEY];
        const next = changeLibrary(previous, action);
        if (JSON.stringify(validateLibrary(previous)) === JSON.stringify(next)) return this.read();
        settings[LIBRARY_KEY] = next;
        try {
            ctx.saveSettingsDebounced();
        } catch (error) {
            if (previous === undefined) delete settings[LIBRARY_KEY];
            else settings[LIBRARY_KEY] = previous;
            throw error;
        }
        return next;
    }

    /**
     * One user-confirmed, current-scope metadata mutation and one settings
     * save request, regardless of the number of selected chats. No JSONL API.
     */
    bulkUpdate({scope,ids,availableIds,operation,value=null}){
        const ctx=this.settingsRoot();
        if(buildingScope(ctx)!==scope)
            throw new Error('캐릭터/그룹이 변경되어 일괄 정리를 중단했습니다.');
        if(typeof ctx.saveSettingsDebounced!=='function')
            throw new Error('SillyTavern 설정 저장 함수를 사용할 수 없습니다.');
        const settings=ctx.extensionSettings;
        const previous=settings[LIBRARY_KEY];
        const result=bulkChangeLibrary(previous,{scope,ids,availableIds,operation,value});
        if(!result.changed)return {...result,saved:false};
        settings[LIBRARY_KEY]=result.library;
        try {ctx.saveSettingsDebounced();}
        catch(error){
            if(previous===undefined)delete settings[LIBRARY_KEY];
            else settings[LIBRARY_KEY]=previous;
            throw error;
        }
        return {...result,saved:true};
    }

    /**
     * Only called after the chat-file API confirms success. Preserve
     * unrelated extensions' data and do not replace malformed metadata.
     */
    syncFileChange(scope,source,destination=null) {
        const ctx=this.settingsRoot();
        const settings=ctx.extensionSettings;
        if(typeof ctx.saveSettingsDebounced!=='function')
            throw new Error('SillyTavern 확장 설정 저장 함수를 사용할 수 없습니다.');
        const previous=settings[LIBRARY_KEY];
        const operation=destination
            ? moveLibraryReference(previous,scope,source,destination)
            : forgetLibraryReference(previous,scope,source);
        if(!operation.changed)return false;
        settings[LIBRARY_KEY]=operation.library;
        try {ctx.saveSettingsDebounced();}
        catch(error) {
            if(previous===undefined)delete settings[LIBRARY_KEY];
            else settings[LIBRARY_KEY]=previous;
            throw error;
        }
        return true;
    }

    /**
     * Restore only new or identical entries. The old namespace remains intact
     * on schema/size/conflict errors; unrelated extension settings never change.
     */
    importAdditively(incoming) {
        const ctx = this.settingsRoot();
        if (typeof ctx.saveSettingsDebounced !== 'function') {
            throw new Error('SillyTavern 설정 저장 함수를 사용할 수 없습니다.');
        }
        const settings = ctx.extensionSettings;
        const before = settings[LIBRARY_KEY];
        const merged = mergeLibrary(before, incoming);
        const after = JSON.stringify(merged);
        const current = JSON.stringify(validateLibrary(before));
        if (after === current) return { changed: false, summary: librarySummary(merged) };
        settings[LIBRARY_KEY] = merged;
        try {
            // Debounced save is not a verified durable write. Report it honestly.
            ctx.saveSettingsDebounced();
        } catch (error) {
            if (before === undefined) delete settings[LIBRARY_KEY];
            else settings[LIBRARY_KEY] = before;
            throw error;
        }
        return { changed: true, summary: librarySummary(merged) };
    }
}
