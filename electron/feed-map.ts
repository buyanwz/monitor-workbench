// 兼容垫片：v0.2.0 的快手映射原先在此文件，v0.3.0 起每平台一个 mapper 模块，
// 快手实现搬到 feed-map-kuaishou.ts；这里只作转发，旧引用方不用改。

export { collectFieldInventory, parseFeedResponse } from "./feed-map-kuaishou";
