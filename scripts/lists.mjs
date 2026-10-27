// Filter lists bundled into the extension. The update script resolves each
// list to an immutable, commit-pinned URL and records it in lists.lock.json;
// the build only ever reads what the lock file pins.

export const LISTS = [
  {
    id: "easylist",
    title: "EasyList",
    file: "easylist.txt",
    canonicalUrl: "https://easylist.to/easylist/easylist.txt",
  },
  {
    id: "easyprivacy",
    title: "EasyPrivacy",
    file: "easyprivacy.txt",
    canonicalUrl: "https://easylist.to/easylist/easyprivacy.txt",
  },
];

// The published lists live on the gh-pages branch of the official EasyList
// repository. Pinning a commit there gives a URL whose content never changes,
// which easylist.to cannot offer.
export const MIRROR = {
  repo: "https://github.com/easylist/easylist.git",
  branch: "gh-pages",
  rawBase: "https://raw.githubusercontent.com/easylist/easylist",
  note:
    "Official EasyList GitHub repository (github.com/easylist/easylist), gh-pages branch, which holds the " +
    "published lists. Pinned to a commit so the URL is immutable. Used instead of easylist.to, which has no " +
    "versioned URLs and was unreachable from the build environment when this pipeline was set up.",
};

export const LOCK_FILE = "lists.lock.json";
export const CACHE_DIR = ".cache/lists";
