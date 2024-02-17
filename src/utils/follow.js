import FollowProtocol from "./protob/follow_pb";
import db from "./idb";
import Lodash from "lodash";
import { renewAccessTokenIfExpired, getAccessToken } from "./account";
import axios from "axios";
import CONFIG from "@/config.json";
import storage from "store2";
import { SnackbarProgrammatic as Snackbar } from "buefy";

const FOLLOW_DATABASE_NAME = "follow";
const PAGE_LIMIT = 50;

const syncFollowDEBU = Lodash.debounce(
  async () => {
    Snackbar.open({
      duration: 2000,
      message: "关注列表上传中...",
      queue: false,
    });
    if ((await countFollow()) === 0) {
      return;
    }
    await uploadFollow();
  },
  2000,
  {
    maxWait: 10,
  }
);

export async function addFollow(user) {
  if (!storage.has("last_follow_modify")) {
    if (!(await syncFollow())) {
      Snackbar.open({
        duration: 2000,
        message: "关注列表同步失败，请检查网络",
        type: "is-danger",
        queue: false,
      });
      return;
    }
  }
  storage.set("last_follow_modify", Date.now());
  let simpleUser = Lodash.pick(user, ["id", "name", "bio"]);
  simpleUser["url"] = user["image"]["url"];
  simpleUser["time"] = new Date().getTime();
  let count = await db[FOLLOW_DATABASE_NAME].update(
    simpleUser["id"],
    simpleUser
  );
  if (count === 0) {
    await db[FOLLOW_DATABASE_NAME].add(simpleUser);
  }
  syncFollowDEBU();
  return true;
}

export async function deleteFollow(id) {
  storage.set("last_follow_modify", Date.now());
  await db[FOLLOW_DATABASE_NAME].delete(id);
  syncFollowDEBU();
}

export async function countFollow() {
  return await db[FOLLOW_DATABASE_NAME].count();
}

export async function clearFollow() {
  storage.set("last_follow_modify", Date.now());
  await db[FOLLOW_DATABASE_NAME].clear();
  Snackbar.open({
    duration: 2000,
    message: "关注列表已清空。",
    queue: false,
  });
  syncFollowDEBU();
}

export async function getFollow(page) {
  return await db[FOLLOW_DATABASE_NAME].orderBy("time")
    .reverse()
    .offset(page * PAGE_LIMIT)
    .limit(PAGE_LIMIT)
    .toArray();
}

export async function isFollowed(id) {
  return (await db[FOLLOW_DATABASE_NAME].get(id)) !== undefined;
}

export async function uploadFollow() {
  let collect = new FollowProtocol.Follows();
  await db[FOLLOW_DATABASE_NAME].toCollection().each((user) => {
    let obj = new FollowProtocol.UserSimple();
    obj.setId(user.id);
    obj.setName(user.name);
    obj.setBio(user.bio);
    obj.setUrl(user.url);
    obj.setTime(user.time);
    collect.addUsers(obj);
  });
  collect.setTime(storage.get("last_follow_modify", 0));
  let bin = collect.serializeBinary();
  await renewAccessTokenIfExpired();
  await axios.put(CONFIG.USER_API + "follow", bin, {
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
    },
    background: true,
  });
}

export async function syncFollow() {
  Snackbar.open({
    duration: 2000,
    message: "关注列表同步中...",
    queue: false,
  });

  await renewAccessTokenIfExpired();
  let res;
  try {
    res = await axios.get(CONFIG.USER_API + "follow", {
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
      },
      responseType: "arraybuffer",
      background: true,
    });
  } catch (e) {
    if (e.response.status == 404) {
      await uploadFollow();
    } else {
      return false;
    }
  }

  let remoteData = FollowProtocol.Follows.deserializeBinary(res.data);

  let lastModifyTimeRemote = remoteData.getTime();
  let lastModifyTimeLocal = storage.get("last_follow_modify", 0);

  if (lastModifyTimeRemote == lastModifyTimeLocal) {
    return true;
  } else if (lastModifyTimeRemote < lastModifyTimeLocal) {
    await uploadFollow();
    return true;
  }

  let usersList = remoteData.getUsersList().map((i) => i.toObject());

  await db.transaction("rw", db[FOLLOW_DATABASE_NAME], async () => {
    await db[FOLLOW_DATABASE_NAME].clear();
    await db[FOLLOW_DATABASE_NAME].bulkPut(usersList);
  });

  return true;
}
