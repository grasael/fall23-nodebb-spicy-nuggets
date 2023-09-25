import _ from 'lodash';
import meta from '../meta';
import db from '../database';
import plugins from '../plugins';
import user from '../user';
import topics from '../topics';
import categories from '../categories';
import groups from '../groups';
import utils from '../utils';

export = function (Posts: any) {
    interface CustomData {
        content: string;
        timestamp: number;
        isMain: boolean;
        uid: string;
        tid: number;
        toPid: unknown;
        ip?: number;
        handle?: boolean;
        isanon?: boolean; // Added isanon field
    }

    interface PostData {
        pid: number;
        uid: string;
        tid: number;
        cid: number | null;
        content: string;
        timestamp: number;
        isMain: boolean | null;
        toPid: number | null;
        ip: number | null;
        handle: boolean | null;
        anon: string; // Added anon field
    }

    async function addReplyTo(postData: PostData, timestamp: number) {
        if (!postData.toPid) {
            return;
        }

        await Promise.all([
            db.sortedSetAdd(`pid:${postData.toPid}:replies`, timestamp, postData.pid),
            db.incrObjectField(`post:${postData.toPid}`, 'replies'),
        ]);
    }

    Posts.create = async function (data: CustomData) {
        // This is an internal method, consider using Topics.reply instead
        const { uid, tid, content: rawContent, timestamp: rawTimestamp, isMain: rawIsMain, isanon } = data;
        const content = rawContent.toString();
        const timestamp = rawTimestamp || Date.now();
        const isMain = rawIsMain || false;

        if (!uid && parseInt(uid, 10) !== 0) {
            throw new Error('[[error:invalid-uid]]');
        }

        if (data.toPid && !utils.isNumber(data.toPid)) {
            throw new Error('[[error:invalid-pid]]');
        }

        let anonname = await user.getUserField(uid, 'username');

        if (isanon) {
            anonname = 'Anonymous';
        }

        const pid = await db.incrObjectField('global', 'nextPid') as number;

        let postData: PostData = {
            pid,
            uid,
            tid,
            cid: null,
            content,
            timestamp,
            toPid: null,
            handle: null,
            ip: null,
            isMain: null,
            anon: anonname, // Added anon field
        };

        if (data.toPid && !utils.isNumber(data.toPid as number)) {
            throw new Error('[[error:invalid-pid]]');
        }

        if (data.ip && meta.config.trackIpPerPost) {
            postData.ip = data.ip;
        }

        if (data.handle && !parseInt(uid as string, 10)) {
            postData.handle = data.handle;
        }

        try {
            const result = await plugins.hooks.fire('filter:post.create', { post: postData, data }) as { post: PostData, data: CustomData };
            postData = result.post;

            await db.setObject(`post:${postData.pid}`, postData);

            const topicData: { cid: number, pinned: boolean } = await topics.getTopicFields(tid, ['cid', 'pinned']) as { cid: number, pinned: boolean };
            postData.cid = topicData.cid;

            await Promise.all([
                db.sortedSetAdd('posts:pid', timestamp, postData.pid),
                db.incrObjectField('global', 'postCount'),
                user.onNewPostMade(postData),
                topics.onNewPostMade(postData),
                categories.onNewPostMade(topicData.cid, topicData.pinned, postData),
                groups.onNewPostMade(postData),
                addReplyTo(postData, timestamp),
                Posts.uploads.sync(postData.pid),
            ]);

            const finalResult = await plugins.hooks.fire('filter:post.get', { post: postData, uid: data.uid }) as { post: PostData, uid: string };
            finalResult.post.isMain = isMain;
            await plugins.hooks.fire('action:post.save', { post: _.clone(finalResult.post) });
            return finalResult.post;
        } catch (error) {
            console.error(error);
            throw error;
        }
    };
};
