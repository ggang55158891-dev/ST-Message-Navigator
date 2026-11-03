/**
 * Pure, read-only Quiet folder tree projection.
 * A virtual folder points to the existing library record, never to a moved
 * JSONL file. Only the current character/group scope is passed to this helper.
 */
import { selectLibraryChats } from './library-operations.js';

export const FOLDER_DRAWER_PAGE_SIZE = 30;

export function buildQuietFolderSections(buildings, scope, library) {
    const all = selectLibraryChats(buildings, scope, library, {sort:'recent'});
    const folders = library.folders.map(({id,name}) => ({
        key:'folder:'+id, kind:'folder', folderId:id, name, items:[],
    }));
    const folderMap = new Map(folders.map(section=>[section.folderId,section]));
    const favorites = [];
    const unfiled = [];
    for (const chat of all) {
        if (chat.favorite) favorites.push(chat);
        if (chat.folderId && folderMap.has(chat.folderId)) folderMap.get(chat.folderId).items.push(chat);
        else unfiled.push(chat);
    }
    return [
        {key:'all',kind:'all',folderId:null,name:'전체 채팅',items:all},
        {key:'favorites',kind:'favorites',folderId:null,name:'즐겨찾기',items:favorites},
        ...folders,
        {key:'unfiled',kind:'unfiled',folderId:null,name:'미분류',items:unfiled},
    ];
}
