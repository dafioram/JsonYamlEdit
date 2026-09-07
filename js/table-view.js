/*
 * Brace — table-view.js
 *
 * Renders an array-of-objects as a table. Columns are the union of keys
 * across all rows (real-world data is rarely perfectly uniform), missing
 * fields render as a muted dash, and nested object/array cells collapse
 * into a small badge that expands a mini tree in a popover rather than
 * breaking the table layout.
 */
(function (global) {
  "use strict";

  var Brace = global.Brace = global.Brace || {};
  var typeOf = Brace.treeView.typeOf;

  function collectColumns(rows) {
    var seen = new Set();
    var order = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      for (var key in row) {
        if (Object.prototype.hasOwnProperty.call(row, key) && !seen.has(key)) {
          seen.add(key);
          order.push(key);
        }
      }
    }
    return order;
  }

  function cellSortValue(value) {
    var type = typeOf(value);
    if (type === "number") return value;
    if (type === "boolean") return value ? 1 : 0;
    if (type === "null" || value === undefined) return "";
    if (type === "string") return value.toLowerCase();
    return JSON.stringify(value); // objects/arrays sort by their JSON text
  }

  function csvEscape(value) {
    var s;
    var type = typeOf(value);
    if (value === undefined || type === "null") s = "";
    else if (type === "object" || type === "array") s = JSON.stringify(value);
    else s = String(value);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function TableView(container, popoverHost) {
    this.container = container;
    this.popoverHost = popoverHost;
    this.rows = [];
    this.columns = [];
    this.sortCol = null;
    this.sortDir = 0; // 0 none, 1 asc, -1 desc
    this.filterTerm = "";
  }

  TableView.prototype.setData = function (rows) {
    this.rows = rows;
    this.columns = collectColumns(rows);
    this.sortCol = null;
    this.sortDir = 0;
    this.filterTerm = "";
    this.renderAll();
  };

  TableView.prototype.setFilter = function (term) {
    this.filterTerm = term || "";
    this.renderAll();
  };

  TableView.prototype._filteredSortedRows = function () {
    var rows = this.rows;
    if (this.filterTerm) {
      var needle = this.filterTerm.toLowerCase();
      rows = rows.filter(function (row) {
        for (var k in row) {
          if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
          var v = row[k];
          var t = typeOf(v);
          var s = (t === "object" || t === "array") ? JSON.stringify(v) : String(v);
          if (s.toLowerCase().indexOf(needle) !== -1) return true;
        }
        return false;
      });
    }
    if (this.sortCol && this.sortDir !== 0) {
      var col = this.sortCol, dir = this.sortDir;
      rows = rows.slice().sort(function (a, b) {
        var av = cellSortValue(a[col]), bv = cellSortValue(b[col]);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  };

  TableView.prototype.renderAll = function () {
    var self = this;
    this.container.innerHTML = "";

    var summary = document.createElement("div");
    summary.className = "table-summary";
    var visibleRows = this._filteredSortedRows();
    summary.textContent = visibleRows.length + " row" + (visibleRows.length === 1 ? "" : "s") +
      " \u00B7 " + this.columns.length + " column" + (this.columns.length === 1 ? "" : "s");
    this.container.appendChild(summary);

    var table = document.createElement("table");
    table.className = "data-table";

    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    this.columns.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col;
      var arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      if (self.sortCol === col && self.sortDir !== 0) {
        arrow.textContent = self.sortDir === 1 ? " \u2191" : " \u2193";
      }
      th.appendChild(arrow);
      th.addEventListener("click", function () {
        if (self.sortCol !== col) {
          self.sortCol = col;
          self.sortDir = 1;
        } else if (self.sortDir === 1) {
          self.sortDir = -1;
        } else if (self.sortDir === -1) {
          self.sortCol = null;
          self.sortDir = 0;
        } else {
          self.sortDir = 1;
        }
        self.renderAll();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    visibleRows.forEach(function (row) {
      var tr = document.createElement("tr");
      self.columns.forEach(function (col) {
        var td = document.createElement("td");
        var has = Object.prototype.hasOwnProperty.call(row, col);
        var value = row[col];
        if (!has) {
          td.className = "cell-empty";
          td.textContent = "\u2013";
        } else {
          self._renderCell(td, value);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    this.container.appendChild(table);
  };

  TableView.prototype._renderCell = function (td, value) {
    var self = this;
    var type = typeOf(value);
    if (type === "object" || type === "array") {
      var count = type === "array" ? value.length : Object.keys(value).length;
      var badge = document.createElement("button");
      badge.type = "button";
      badge.className = "cell-badge";
      badge.textContent = type === "array" ? "[" + count + "]" : "{" + count + "}";
      badge.addEventListener("click", function (e) {
        self._showPopover(e.currentTarget, value);
      });
      td.appendChild(badge);
      return;
    }
    if (type === "null") {
      td.className = "cell-null";
      td.textContent = "null";
      return;
    }
    if (type === "number") td.className = "cell-number";
    if (type === "boolean") td.className = "cell-boolean";
    if (type === "string") td.className = "cell-string";
    td.textContent = type === "string" ? value : String(value);
  };

  TableView.prototype._showPopover = function (anchorEl, value) {
    var host = this.popoverHost;
    host.innerHTML = "";
    var pop = document.createElement("div");
    pop.className = "cell-popover";
    var rect = anchorEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + "px";
    pop.style.left = (rect.left + window.scrollX) + "px";

    var closeBtn = document.createElement("button");
    closeBtn.className = "cell-popover-close";
    closeBtn.type = "button";
    closeBtn.textContent = "\u00D7";
    closeBtn.addEventListener("click", function () { host.innerHTML = ""; });
    pop.appendChild(closeBtn);

    var treeContainer = document.createElement("div");
    pop.appendChild(treeContainer);
    host.appendChild(pop);

    var tv = Brace.treeView.create(treeContainer, {});
    tv.render(value, typeOf(value) === "array" ? "value" : "value");

    setTimeout(function () {
      document.addEventListener("click", function onDocClick(e) {
        if (!pop.contains(e.target) && e.target !== anchorEl) {
          host.innerHTML = "";
          document.removeEventListener("click", onDocClick);
        }
      });
    }, 0);
  };

  TableView.prototype.toCSV = function () {
    var rows = this._filteredSortedRows();
    var lines = [this.columns.map(csvEscape).join(",")];
    rows.forEach(function (row) {
      lines.push(this.columns.map(function (col) { return csvEscape(row[col]); }).join(","));
    }, this);
    return lines.join("\n");
  };

  Brace.tableView = {
    create: function (container, popoverHost) { return new TableView(container, popoverHost); },
    isCandidate: function (value) { return Brace.treeView.isTableCandidate(value); }
  };
})(window);
