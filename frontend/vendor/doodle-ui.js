/**
 * doodle-ui.js — visual-only enhancements for the Socius AI doodle theme.
 *
 *  1. Sparkle burst   → a small pop of doodle stars when pressing SIGN IN / Continue
 *  2. Mouse parallax  → gate & login doodles drift gently with the cursor
 *  3. Time-aware greeting → "Good morning / afternoon / evening, Name"
 *
 * Everything here is decoration only: no forms, buttons, navigation or app
 * logic are modified — existing handlers keep running exactly as before.
 * Honors prefers-reduced-motion (all effects are skipped when enabled).
 */

(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  /* ---------------------------------------------------------------
     1. Sparkle burst — doodle stars fly out from a click point
     --------------------------------------------------------------- */
  function sparkleBurst(clientX, clientY) {
    if (prefersReducedMotion.matches || typeof clientX !== "number") return;

    var symbols = ["dd-sparkle", "dd-star", "dd-plus", "dd-sparkle", "dd-star"];
    var colors = ["#ffd9e0", "#ffffff", "#ff9db4", "#ff5f7e", "#ffb3c6"];
    var total = 12;

    var layer = document.createElement("div");
    layer.className = "sparkle-burst";
    layer.setAttribute("aria-hidden", "true");
    layer.style.left = clientX + "px";
    layer.style.top = clientY + "px";
    document.body.appendChild(layer);

    for (var i = 0; i < total; i += 1) {
      var svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "doodle burst-bit");
      svg.setAttribute("aria-hidden", "true");

      var use = document.createElementNS(SVG_NS, "use");
      use.setAttribute("href", "#" + symbols[i % symbols.length]);
      svg.appendChild(use);

      var angle = (Math.PI * 2 * i) / total + (Math.random() * 0.7 - 0.35);
      var distance = 40 + Math.random() * 55;
      var size = 11 + Math.random() * 13;
      var rotation = Math.round(Math.random() * 160 - 80);

      svg.style.width = size + "px";
      svg.style.height = size + "px";
      svg.style.color = colors[i % colors.length];
      layer.appendChild(svg);

      if (typeof svg.animate === "function") {
        svg.animate(
          [
            {
              transform: "translate(-50%, -50%) scale(0.3) rotate(0deg)",
              opacity: 1
            },
            {
              transform:
                "translate(calc(-50% + " + Math.round(Math.cos(angle) * distance) +
                "px), calc(-50% + " + Math.round(Math.sin(angle) * distance) +
                "px)) scale(1) rotate(" + rotation + "deg)",
              opacity: 0
            }
          ],
          {
            duration: 700 + Math.random() * 400,
            easing: "cubic-bezier(0.15, 0.7, 0.35, 1)",
            fill: "forwards"
          }
        );
      }
    }

    window.setTimeout(function () {
      if (layer.parentNode) layer.parentNode.removeChild(layer);
    }, 1300);
  }

  /* ---------------------------------------------------------------
     2. Mouse parallax — doodles shift a few pixels via --doodle-x/y
        (the float/twinkle keyframes read those variables, so the
        existing animations keep playing while the parallax layers on)
     --------------------------------------------------------------- */
  function attachParallax(container, itemSelector, maxDepth) {
    if (!container || prefersReducedMotion.matches) return;

    var items = Array.prototype.slice.call(container.querySelectorAll(itemSelector));
    if (!items.length) return;

    items.forEach(function (el, index) {
      var depth = maxDepth * (1 - (index % 4) * 0.22);
      el.setAttribute("data-depth", String(depth.toFixed(1)));
    });

    var targetX = 0;
    var targetY = 0;
    var currentX = 0;
    var currentY = 0;
    var tracking = false;
    var frame = 0;

    function paint() {
      items.forEach(function (el) {
        var depth = parseFloat(el.getAttribute("data-depth")) || 8;
        el.style.setProperty("--doodle-x", (currentX * depth).toFixed(2) + "px");
        el.style.setProperty("--doodle-y", (currentY * depth).toFixed(2) + "px");
      });
    }

    function tick() {
      currentX += (targetX - currentX) * 0.09;
      currentY += (targetY - currentY) * 0.09;
      paint();

      var settled =
        Math.abs(targetX - currentX) < 0.002 && Math.abs(targetY - currentY) < 0.002;

      if (tracking || !settled) {
        frame = window.requestAnimationFrame(tick);
      } else {
        currentX = targetX;
        currentY = targetY;
        paint();
        frame = 0;
      }
    }

    function kick() {
      if (!frame) frame = window.requestAnimationFrame(tick);
    }

    container.addEventListener("pointermove", function (event) {
      var rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      targetX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      targetY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      tracking = true;
      kick();
    });

    container.addEventListener("pointerleave", function () {
      targetX = 0;
      targetY = 0;
      tracking = false;
      kick();
    });
  }

  /* ---------------------------------------------------------------
     3. Time-aware greeting — only the text node before the name span
        (the inline app script owns the span itself, so no conflict)
     --------------------------------------------------------------- */
  function updateGreeting() {
    var nameElement = document.getElementById("dashboardName");
    if (!nameElement || !nameElement.parentElement) return;

    var firstNode = nameElement.parentElement.firstChild;
    if (!firstNode || firstNode.nodeType !== 3) return;

    var hour = new Date().getHours();
    var partOfDay =
      hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

    firstNode.nodeValue = partOfDay + ", ";
  }

  /* ---------------------------------------------------------------
     init
     --------------------------------------------------------------- */
  onReady(function () {
    updateGreeting();

    var gateButton = document.getElementById("welcomeSignInBtn");
    if (gateButton) {
      gateButton.addEventListener("click", function (event) {
        sparkleBurst(event.clientX, event.clientY);
      });
    }

    var loginSubmit = document.querySelector(".login-submit");
    if (loginSubmit) {
      loginSubmit.addEventListener("click", function (event) {
        sparkleBurst(event.clientX, event.clientY);
      });
    }

    attachParallax(document.querySelector(".welcome-card"), ".gate-doodle", 16);
    attachParallax(document.querySelector(".login-visual"), ".lv-doodle", 14);
  });
})();
