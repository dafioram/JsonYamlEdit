/*
 * Brace — tree-view.js
 *
 * A collapsible tree renderer for arbitrary JSON-like data. Children are
 * only built into the DOM the first time a node is expanded, so opening a
 * large file doesn't pay to render everything up front — only "Expand all"
 * does, and that's gated behind a node-count warning for very large trees.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};

  var EXPAND_ALL_WARN_THRESHOLD = 4000;
  var STRING_TRUNCATE_LENGTH = 140;

  function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    var t = typeof value;
    if (t === "object") return "object";
    return t; // "string" | "number" | "boolean"
  }

  function countDescendants(value) {
    var count = 0;
    var type = typeOf(value);
    if (type === "object") {
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          count += 1 + countDescendants(value[k]);
        }
      }
    } else if (type === "array") {
      for (var i = 0; i < value.length; i++) {
        count += 1 + countDescendants(value[i]);
      }
    }
    return count;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatPath(segments) {
    var out = "root";
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      out += seg.type === "index" ? "[" + seg.index + "]" : "." + seg.name;
    }
    return out;
  }

  function resolvePath(data, segments) {
    var cur = data;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      cur = seg.type === "index" ? cur[seg.index] : cur[seg.name];
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
    this.matchSet = null; // Set of path-strings that must stay visible during search
    this.matchSegPaths = null; // array of segment-arrays, for building ancestor chains
  }

  TreeView.prototype.render = function (data, rootLabel) {
    this.rootData = data;
    this._lastRootLabel = rootLabel;
    this.matchSet = null;
    this.container.innerHTML = "";
    this._nodeCount = countDescendants(data);

    var root = this._buildNode(rootLabel || "root", data, [], 0, true);
    this._rootNodeResult = root;
    this.container.appendChild(root.row);
    if (root.childrenContainer) {
      this.container.appendChild(root.childrenContainer);
      if (root.expandFn) root.expandFn(true); // auto-expand first level for orientation
    }
  };

  TreeView.prototype.expandAll = function () {
    if (this._nodeCount > EXPAND_ALL_WARN_THRESHOLD) {
      var ok = global.confirm(
        "This tree has about " + this._nodeCount.toLocaleString() +
        " nodes. Expanding all of them may be slow. Continue?"
      );
      if (!ok) return;
    }
    this._walkAndToggle(this._rootNodeResult, true);
  };

  TreeView.prototype.collapseAll = function () {
    this._walkAndToggle(this._rootNodeResult, false);
  };

  // Recurses through actual node-result references (not a DOM query
  // snapshot) so it correctly reaches children built as a result of this
  // very call, at any depth.
  TreeView.prototype._walkAndToggle = function (nodeResult, open) {
    if (!nodeResult || !nodeResult.expandFn) return;
    nodeResult.expandFn(open);
    var kids = nodeResult.childrenContainer && nodeResult.childrenContainer._childResults;
    if (kids) {
      for (var i = 0; i < kids.length; i++) this._walkAndToggle(kids[i], open);
    }
  };

  // Builds one row + (if expandable) a lazy children container. Returns
  // { row, childrenContainer, toggle } — childrenContainer is only
  // populated the first time it's expanded.
  TreeView.prototype._buildNode = function (label, value, segments, depth, isRoot) {
    var self = this;
    var type = typeOf(value);
    var expandable = type === "object" || type === "array";

    var row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = (depth * 18 + 6) + "px";

    var toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = expandable ? "\u25B8" : "\u00A0";
    if (expandable) toggle.setAttribute("data-expandable", "1");
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

      doExpand = function (open) {
        expanded = open;
        toggle.textContent = open ? "\u25BE" : "\u25B8";
        childrenContainer.hidden = !open;
        if (open && !childrenContainer._built) {
          childrenContainer._childResults = self._populateChildren(childrenContainer, value, segments, depth + 1, type);
          childrenContainer._built = true;
        }
      };
      toggle._braceToggle = doExpand;
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

  // Returns an array of child node-results (not just DOM nodes) so callers
  // like expandAll can recurse into structure that was just lazily built,
  // rather than re-querying a DOM snapshot that wouldn't include it yet.
  TreeView.prototype._populateChildren = function (container, value, parentSegments, depth, parentType) {
    var results = [];
    if (parentType === "array") {
      for (var i = 0; i < value.length; i++) {
        var segs = parentSegments.concat([{ type: "index", index: i }]);
        var child = this._buildNode(String(i) + ":", value[i], segs, depth, false);
        container.appendChild(child.row);
        if (child.childrenContainer) container.appendChild(child.childrenContainer);
        results.push(child);
      }
    } else {
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var segs2 = parentSegments.concat([{ type: "key", name: key }]);
        var child2 = this._buildNode(key + ":", value[key], segs2, depth, false);
        container.appendChild(child2.row);
        if (child2.childrenContainer) container.appendChild(child2.childrenContainer);
        results.push(child2);
      }
    }
    return results;
  };

  TreeView.prototype._formatScalar = function (value, type) {
    if (type === "string") {
      var s = value.length > STRING_TRUNCATE_LENGTH ? value.slice(0, STRING_TRUNCATE_LENGTH) + "\u2026" : value;
      return '"' + s + '"';
    }
    if (type === "null") return "null";
    return String(value);
  };

  // ---- Search --------------------------------------------------------
  // Full re-render showing only paths that lead to a match (key name or
  // scalar value containing the search term, case-insensitive). Given the
  // file-size cap this is a full walk + full render, which is fine.
  TreeView.prototype.search = function (term) {
    if (!term) {
      this.render(this.rootData, this._lastRootLabel);
      return;
    }
    var needle = term.toLowerCase();
    var matchedSegPaths = [];

    (function walk(value, segments) {
      var type = typeOf(value);
      if (type === "object") {
        for (var k in value) {
          if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
          var childSegs = segments.concat([{ type: "key", name: k }]);
          if (k.toLowerCase().indexOf(needle) !== -1) matchedSegPaths.push(childSegs);
          walk(value[k], childSegs);
        }
      } else if (type === "array") {
        for (var i = 0; i < value.length; i++) {
          var childSegs2 = segments.concat([{ type: "index", index: i }]);
          walk(value[i], childSegs2);
        }
      } else {
        var strVal = type === "null" ? "null" : String(value);
        if (strVal.toLowerCase().indexOf(needle) !== -1) matchedSegPaths.push(segments);
      }
    })(this.rootData, []);

    this.container.innerHTML = "";
    if (matchedSegPaths.length === 0) {
      var empty = document.createElement("div");
      empty.className = "tree-empty-note";
      empty.textContent = 'No keys or values match "' + term + '".';
      this.container.appendChild(empty);
      return;
    }

    // Build a prefix-tree of segment paths that must be expanded/visible.
    var visiblePrefixes = new Set(["root"]);
    matchedSegPaths.forEach(function (segs) {
      var acc = "root";
      segs.forEach(function (seg) {
        acc += seg.type === "index" ? "[" + seg.index + "]" : "." + seg.name;
        visiblePrefixes.add(acc);
      });
    });

    var root = this._buildFilteredNode("root", this.rootData, [], 0, true, visiblePrefixes, "root");
    this._rootNodeResult = root;
    this.container.appendChild(root.row);
    if (root.childrenContainer) this.container.appendChild(root.childrenContainer);
  };

  TreeView.prototype._buildFilteredNode = function (label, value, segments, depth, isRoot, visiblePrefixes, pathStr) {
    var node = this._buildNode(label, value, segments, depth, isRoot);
    if (node.childrenContainer) {
      var self = this;
      var type = typeOf(value);
      var toggleEl = node.row.querySelector(".tree-toggle");

      // Override lazy population to only include children on a visible
      // prefix, and keep expandFn / _childResults in sync so expandAll /
      // collapseAll (which recurse via those, not via DOM queries) still
      // work correctly on a filtered tree.
      var filteredExpand = function (open) {
        node.childrenContainer.hidden = !open;
        toggleEl.textContent = open ? "\u25BE" : "\u25B8";
        if (open && !node.childrenContainer._built) {
          var results = [];
          if (type === "array") {
            for (var i = 0; i < value.length; i++) {
              var childPath = pathStr + "[" + i + "]";
              if (!visiblePrefixes.has(childPath)) continue;
              var segs = segments.concat([{ type: "index", index: i }]);
              var child = self._buildFilteredNode(i + ":", value[i], segs, depth + 1, false, visiblePrefixes, childPath);
              node.childrenContainer.appendChild(child.row);
              if (child.childrenContainer) node.childrenContainer.appendChild(child.childrenContainer);
              results.push(child);
            }
          } else {
            var keys = Object.keys(value);
            for (var k = 0; k < keys.length; k++) {
              var key = keys[k];
              var childPath2 = pathStr + "." + key;
              if (!visiblePrefixes.has(childPath2)) continue;
              var segs2 = segments.concat([{ type: "key", name: key }]);
              var child2 = self._buildFilteredNode(key + ":", value[key], segs2, depth + 1, false, visiblePrefixes, childPath2);
              node.childrenContainer.appendChild(child2.row);
              if (child2.childrenContainer) node.childrenContainer.appendChild(child2.childrenContainer);
              results.push(child2);
            }
          }
          node.childrenContainer._childResults = results;
          node.childrenContainer._built = true;
        }
      };
      toggleEl._braceToggle = filteredExpand;
      node.expandFn = filteredExpand;
      filteredExpand(true); // auto-expand every node on a visible-prefix chain
    }
    return node;
  };

  Brace.treeView = {
    create: function (container, options) { return new TreeView(container, options); },
    resolvePath: resolvePath,
    formatPath: formatPath,
    isTableCandidate: isTableCandidate,
    typeOf: typeOf
  };
})(window);
