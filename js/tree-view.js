/*
 * Brace — tree-view.js
 *
 * A collapsible tree renderer for arbitrary JSON-like data. Children are
 * built in batches as nodes expand, with a cap on total rendered rows.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  var MAX_TREE_ROWS = 4000;
  var CHILD_BATCH_SIZE = 100;
  var MAX_SEARCH_MATCHES = 100;
  var STRING_TRUNCATE_LENGTH = 140;

  function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    var t = typeof value;
    if (t === "object") return "object";
    return t; // "string" | "number" | "boolean"
  }

  function formatPath(segments) {
    var out = "root";
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.type === "index") out += "[" + seg.index + "]";
      else if (/^[A-Za-z_$][\w$]*$/.test(seg.name)) out += "." + seg.name;
      else out += "[" + JSON.stringify(seg.name) + "]";
    }
    return out;
  }

  function resolvePath(data, segments) {
    var cur = data;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (cur === null || typeof cur !== "object") return undefined;
      if ((seg.type === "index") !== Array.isArray(cur)) return undefined;
      var key = seg.type === "index" ? seg.index : seg.name;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  // Returns true if `value` is an array where every element is a plain
  // object (the shape Table view can render). Empty arrays don't qualify.
  function isTableCandidate(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    for (var i = 0; i < value.length; i++) {
      if (typeOf(value[i]) !== "object") return false;
    }
    return true;
  }

  function TreeView(container, options) {
    this.container = container;
    this.options = options || {};
    this.rootData = null;
    this.searchPaths = null;
  }

  TreeView.prototype.render = function (data, rootLabel) {
    this.rootData = data;
    this._lastRootLabel = rootLabel;
    this.searchPaths = null;
    this._renderRoot();
  };

  TreeView.prototype._renderRoot = function () {
    this.container.replaceChildren();
    this.rowCount = 0;
    this.limitNote = null;
    var root = this._buildNode(this._lastRootLabel || "root", this.rootData, [], 0, true);
    this._rootNodeResult = root;
    this.container.appendChild(root.row);
    if (root.childrenContainer) {
      this.container.appendChild(root.childrenContainer);
      root.expandFn(true);
    }
  };

  TreeView.prototype._showLimit = function () {
    if (this.limitNote) return;
    this.limitNote = document.createElement("div");
    this.limitNote.className = "tree-empty-note";
    this.limitNote.textContent = "Tree display limit reached. Search for a narrower branch or collapse all to reset.";
    this.container.prepend(this.limitNote);
  };

  TreeView.prototype.expandAll = function () {
    function expand(node) {
      if (!node || !node.expandFn) return;
      node.expandFn(true, true).forEach(expand);
    }
    expand(this._rootNodeResult);
  };

  TreeView.prototype.collapseAll = function () {
    if (!this._rootNodeResult) return;
    this._renderRoot();
    if (this._rootNodeResult.expandFn) this._rootNodeResult.expandFn(false);
  };

  // Builds one row + (if expandable) a lazy children container. Returns
  // { row, childrenContainer, toggle } — childrenContainer is only
  // populated the first time it's expanded.
  TreeView.prototype._buildNode = function (label, value, segments, depth, isRoot) {
    var self = this;
    var type = typeOf(value);
    var expandable = type === "object" || type === "array";
    this.rowCount++;

    var row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = (depth * 18 + 6) + "px";

    var toggle = document.createElement(expandable ? "button" : "span");
    toggle.className = "tree-toggle";
    toggle.textContent = expandable ? "\u25B8" : "\u00A0";
    if (expandable) {
      toggle.type = "button";
      toggle.setAttribute("data-expandable", "1");
      toggle.setAttribute("aria-label", "Toggle " + label);
    }
    row.appendChild(toggle);

    var keyEl = document.createElement("span");
    keyEl.className = "tree-key";
    keyEl.textContent = label;
    if (!isRoot) row.appendChild(keyEl);
    else {
      keyEl.className += " tree-key-root";
      row.appendChild(keyEl);
    }

    var childrenContainer = null;
    var expanded = false;
    var doExpand = null;

    if (expandable) {
      var count = type === "array" ? value.length : Object.keys(value).length;
      var badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = type === "array"
        ? (count + (count === 1 ? " item" : " items"))
        : (count + (count === 1 ? " key" : " keys"));
      row.appendChild(badge);

      childrenContainer = document.createElement("div");
      childrenContainer.className = "tree-children";
      childrenContainer.hidden = true;

      var results = [];
      var keys = null;
      var nextIndex = 0;
      var more = document.createElement("button");
      more.type = "button";
      more.className = "btn btn-small tree-more";
      more.textContent = "Show more";

      function appendChildren(limit) {
        if (more.parentNode) more.remove();
        var isArray = type === "array";
        var visible = self.searchPaths && self.searchPaths.get(formatPath(segments));
        if (!keys && (visible || self.searchPaths || !isArray)) {
          keys = visible ? Array.from(visible) : self.searchPaths ? [] : Object.keys(value);
        }
        var count = keys ? keys.length : value.length;
        var batch = document.createDocumentFragment();
        while (nextIndex < count && limit > 0 && self.rowCount < MAX_TREE_ROWS) {
          var key = keys ? keys[nextIndex] : nextIndex;
          var segment = isArray ? { type: "index", index: key } : { type: "key", name: key };
          var child = self._buildNode(key + ":", value[key], segments.concat(segment), depth + 1, false);
          batch.appendChild(child.row);
          if (child.childrenContainer) batch.appendChild(child.childrenContainer);
          results.push(child);
          nextIndex++;
          limit--;
        }
        childrenContainer.appendChild(batch);
        if (nextIndex < count) {
          if (self.rowCount < MAX_TREE_ROWS) childrenContainer.appendChild(more);
          else self._showLimit();
        }
      }

      more.addEventListener("click", function () { appendChildren(CHILD_BATCH_SIZE); });
      doExpand = function (open, all) {
        expanded = open;
        toggle.textContent = open ? "\u25BE" : "\u25B8";
        toggle.setAttribute("aria-expanded", String(open));
        childrenContainer.hidden = !open;
        if (open && (nextIndex === 0 || all)) appendChildren(all ? MAX_TREE_ROWS : CHILD_BATCH_SIZE);
        return results;
      };
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", function () { doExpand(!expanded); });
      row.addEventListener("dblclick", function (e) {
        if (e.target === toggle) return;
        doExpand(!expanded);
      });

      if (isTableCandidate(value) && self.options.onUseAsTable) {
        var tableBtn = document.createElement("button");
        tableBtn.className = "tree-action";
        tableBtn.type = "button";
        tableBtn.title = "View as table";
        tableBtn.textContent = "\u25A6 Table";
        tableBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          self.options.onUseAsTable(segments, formatPath(segments));
        });
        row.appendChild(tableBtn);
      }
    } else {
      var valueEl = document.createElement("span");
      valueEl.className = "tree-value tv-" + type;
      valueEl.textContent = this._formatScalar(value, type);
      if (type === "string" && value.length > STRING_TRUNCATE_LENGTH) {
        valueEl.title = value;
      }
      row.appendChild(valueEl);
    }

    var copyBtn = document.createElement("button");
    copyBtn.className = "tree-action tree-action-copy";
    copyBtn.type = "button";
    copyBtn.title = "Copy path";
    copyBtn.textContent = "\u29C9";
    copyBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var pathStr = formatPath(segments);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pathStr);
      }
      copyBtn.textContent = "\u2713";
      setTimeout(function () { copyBtn.textContent = "\u29C9"; }, 900);
    });
    row.appendChild(copyBtn);

    return { row: row, childrenContainer: childrenContainer, expandFn: doExpand };
  };

  TreeView.prototype._formatScalar = function (value, type) {
    if (type === "string") {
      var s = value.length > STRING_TRUNCATE_LENGTH ? value.slice(0, STRING_TRUNCATE_LENGTH) + "\u2026" : value;
      return '"' + s + '"';
    }
    if (type === "null") return "null";
    return String(value);
  };

  TreeView.prototype.search = function (term) {
    if (!term) {
      this.render(this.rootData, this._lastRootLabel);
      return;
    }
    var needle = term.toLowerCase();
    var paths = new Map();
    var matches = 0;
    var truncated = false;

    function addMatch(segments) {
      matches++;
      var prefix = [];
      segments.forEach(function (segment) {
        var path = formatPath(prefix);
        if (!paths.has(path)) paths.set(path, new Set());
        paths.get(path).add(segment.type === "index" ? segment.index : segment.name);
        prefix.push(segment);
      });
    }

    function walk(value, segments, keyMatch) {
      if (matches >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return;
      }
      var type = typeOf(value);
      var branch = type === "object" || type === "array";
      if (keyMatch || (!branch && String(value).toLowerCase().includes(needle))) addMatch(segments);
      if (!branch) return;
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (matches >= MAX_SEARCH_MATCHES) {
          truncated = true;
          break;
        }
        var segment = type === "array" ? { type: "index", index: Number(key) } : { type: "key", name: key };
        walk(value[key], segments.concat(segment), type === "object" && key.toLowerCase().includes(needle));
      }
    }

    walk(this.rootData, [], false);
    this.searchPaths = paths;
    if (matches === 0) {
      this._rootNodeResult = null;
      var empty = document.createElement("div");
      empty.className = "tree-empty-note";
      empty.textContent = 'No keys or values match "' + term + '".';
      this.container.replaceChildren(empty);
      return;
    }
    this._renderRoot();
    this.expandAll();
    if (truncated) {
      var notice = document.createElement("div");
      notice.className = "tree-empty-note";
      notice.textContent = "Showing the first " + MAX_SEARCH_MATCHES + " matches.";
      this.container.prepend(notice);
    }
  };

  Brace.treeView = {
    create: function (container, options) { return new TreeView(container, options); },
    resolvePath: resolvePath,
    formatPath: formatPath,
    isTableCandidate: isTableCandidate,
    typeOf: typeOf
  };
})(window);
