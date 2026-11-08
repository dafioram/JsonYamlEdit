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
  var ROW_PAGE_SIZE = 100;
  var COLUMN_PAGE_SIZE = 50;
  var MAX_CSV_CELLS = 1000000;

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

  function csvEscape(value, spreadsheetSafe) {
    var s;
    var type = typeOf(value);
    if (value === undefined || type === "null") s = "";
    else if (type === "object" || type === "array") s = JSON.stringify(value);
    else s = String(value);
    if (spreadsheetSafe && type === "string" && (/^[\t\r\n]/.test(s) || /^\s*[=+@\-＝＋＠－]/u.test(s))) {
      s = "'" + s;
    }
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
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
    this.rowPage = 0;
    this.columnPage = 0;
    this.onOutsidePopoverClick = null;
  }

  TableView.prototype.setData = function (rows) {
    this.rows = rows;
    this.columns = collectColumns(rows);
    this.sortCol = null;
    this.sortDir = 0;
    this.filterTerm = "";
    this.rowPage = this.columnPage = 0;
    this.renderAll();
  };

  TableView.prototype.setFilter = function (term) {
    this.filterTerm = term || "";
    this.rowPage = 0;
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
    if (this.sortCol !== null && this.sortDir !== 0) {
      var col = this.sortCol, dir = this.sortDir;
      rows = rows.slice().sort(function (a, b) {
        var av = cellSortValue(Object.prototype.hasOwnProperty.call(a, col) ? a[col] : undefined);
        var bv = cellSortValue(Object.prototype.hasOwnProperty.call(b, col) ? b[col] : undefined);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  };

  TableView.prototype._renderPager = function (label, count, size, page, onChange) {
    if (count <= size) return;
    var pager = document.createElement("div");
    pager.className = "table-pager";
    var labelEl = document.createElement("span");
    labelEl.textContent = label + " " + (page * size + 1) + "–" + Math.min(count, (page + 1) * size) + " of " + count;
    pager.appendChild(labelEl);
    [-1, 1].forEach(function (step) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-small";
      button.textContent = (step < 0 ? "Previous " : "Next ") + label.toLowerCase();
      button.disabled = step < 0 ? page === 0 : (page + 1) * size >= count;
      button.addEventListener("click", function () { onChange(page + step); });
      pager.appendChild(button);
    });
    this.container.appendChild(pager);
  };

  TableView.prototype.renderAll = function () {
    var self = this;
    this.closePopover();
    this.container.innerHTML = "";

    var summary = document.createElement("div");
    summary.className = "table-summary";
    var visibleRows = this._filteredSortedRows();
    summary.textContent = visibleRows.length + " row" + (visibleRows.length === 1 ? "" : "s") +
      " \u00B7 " + this.columns.length + " column" + (this.columns.length === 1 ? "" : "s");
    this.container.appendChild(summary);
    this._renderPager("Rows", visibleRows.length, ROW_PAGE_SIZE, this.rowPage, function (page) {
      self.rowPage = page;
      self.renderAll();
    });
    this._renderPager("Columns", this.columns.length, COLUMN_PAGE_SIZE, this.columnPage, function (page) {
      self.columnPage = page;
      self.renderAll();
    });
    var shownRows = visibleRows.slice(this.rowPage * ROW_PAGE_SIZE, (this.rowPage + 1) * ROW_PAGE_SIZE);
    var shownColumns = this.columns.slice(this.columnPage * COLUMN_PAGE_SIZE, (this.columnPage + 1) * COLUMN_PAGE_SIZE);

    var table = document.createElement("table");
    table.className = "data-table";

    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    shownColumns.forEach(function (col) {
      var th = document.createElement("th");
      th.scope = "col";
      var sortButton = document.createElement("button");
      sortButton.type = "button";
      sortButton.className = "table-sort";
      sortButton.textContent = col || "(empty key)";
      th.appendChild(sortButton);
      var arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      if (self.sortCol === col && self.sortDir !== 0) {
        arrow.textContent = self.sortDir === 1 ? " \u2191" : " \u2193";
      }
      sortButton.appendChild(arrow);
      if (self.sortCol === col && self.sortDir) th.setAttribute("aria-sort", self.sortDir === 1 ? "ascending" : "descending");
      sortButton.addEventListener("click", function () {
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
        self.rowPage = 0;
        self.renderAll();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    shownRows.forEach(function (row) {
      var tr = document.createElement("tr");
      shownColumns.forEach(function (col) {
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

  TableView.prototype.closePopover = function () {
    if (this.onOutsidePopoverClick) {
      document.removeEventListener("click", this.onOutsidePopoverClick);
      this.onOutsidePopoverClick = null;
    }
    this.popoverHost.replaceChildren();
  };

  TableView.prototype._showPopover = function (anchorEl, value) {
    var self = this;
    var host = this.popoverHost;
    this.closePopover();
    var pop = document.createElement("div");
    pop.className = "cell-popover";
    var rect = anchorEl.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 4) + "px";
    pop.style.left = (rect.left + window.scrollX) + "px";

    var closeBtn = document.createElement("button");
    closeBtn.className = "cell-popover-close";
    closeBtn.type = "button";
    closeBtn.textContent = "\u00D7";
    closeBtn.setAttribute("aria-label", "Close cell preview");
    closeBtn.addEventListener("click", function () { self.closePopover(); });
    pop.appendChild(closeBtn);

    var treeContainer = document.createElement("div");
    pop.appendChild(treeContainer);
    host.appendChild(pop);

    var tv = Brace.treeView.create(treeContainer, {});
    tv.render(value, "value");

    this.onOutsidePopoverClick = function (e) {
      if (!pop.contains(e.target) && !anchorEl.contains(e.target)) self.closePopover();
    };
    document.addEventListener("click", this.onOutsidePopoverClick);
  };

  TableView.prototype.toCSV = function (spreadsheetSafe) {
    var rows = this._filteredSortedRows();
    if (rows.length * this.columns.length > MAX_CSV_CELLS) {
      throw new Error("This CSV would exceed one million cells. Filter the rows before exporting.");
    }
    var lines = [this.columns.map(function (column) { return csvEscape(column, spreadsheetSafe); }).join(",")];
    rows.forEach(function (row) {
      lines.push(this.columns.map(function (col) {
        var value = Object.prototype.hasOwnProperty.call(row, col) ? row[col] : undefined;
        return csvEscape(value, spreadsheetSafe);
      }).join(","));
    }, this);
    return lines.join("\n");
  };

  Brace.tableView = {
    create: function (container, popoverHost) { return new TableView(container, popoverHost); },
    isCandidate: function (value) { return Brace.treeView.isTableCandidate(value); }
  };
})(window);
