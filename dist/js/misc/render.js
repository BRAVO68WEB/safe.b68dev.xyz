for (
  var render = {
      lsKey: "render",
      type: "miku",
      configs: {
        al: {
          name: "ship waifu~",
          root: "render/al/",
          array: [
            "admiral_graf_spee_1.png",
            "admiral_hipper_1.png",
            "akagi_1.png",
            "akashi_1.png",
            "akashi_2.png",
            "atago_1.png",
            "atago_3.png",
            "atago_4.png",
            "atago_5.png",
            "belfast_2.png",
            "choukai_1.png",
            "deutschland_1.png",
            "enterprise_1.png",
            "glorious_1.png",
            "hammann_1.png",
            "hammann_2.png",
            "hammann_3.png",
            "hatsuharu_1.png",
            "kaga_1.png",
            "kaga_2.png",
            "kaga_3.png",
            "laffey_1.png",
            "laffey_2.png",
            "laffey_3.png",
            "prinz_eugen_3.png",
            "san_diego_1.png",
            "takao_3.png",
            "unicorn_1.png",
            "unicorn_2.png",
            "unicorn_3.png",
            "unicorn_4.png",
            "unicorn_6.png",
            "unicorn_7.png",
            "unicorn_8.png",
            "yamashiro_1.png",
            "yamashiro_2.png",
            "yamashiro_3.png",
            "yukikaze_1.png",
          ],
        },
        miku: {
          name: "miku ❤️~",
          root: "render/miku/",
          array: [],
        },
      },
      config: null,
      selected: null,
      done: !1,
    },
    i = 1;
  i <= 22;
  i++
)
  render.configs.miku.array.push(("00" + i).slice(-3) + ".png");
(render.showTogglePrompt = function () {
  var e = !("0" === localStorage[render.lsKey]),
    n = document.createElement("div");
  n.innerHTML =
    '\n    <div class="field">\n      <div class="control">\n        <label class="checkbox">\n          <input id="swalRender" type="checkbox" ' +
    (e ? "checked" : "") +
    ">\n          Enable random render of " +
    render.config.name +
    '\n        </label>\n      </div>\n      <p class="help">If disabled, you will still be able to see a small button on the bottom right corner of the screen to re-enable it.</p>\n    </div>\n  ';
  var r = {};
  e &&
    (r.reload = {
      text: "Nah fam, show me a different render",
      className: "swal-button--cancel",
    }),
    (r.confirm = !0),
    swal({
      content: n,
      buttons: r,
    }).then(function (e) {
      if ("reload" === e) render.do(!0);
      else if (e) {
        var r = n.querySelector("#swalRender").checked ? void 0 : "0";
        r !== localStorage[render.lsKey] &&
          (r
            ? (localStorage[render.lsKey] = r)
            : localStorage.removeItem(render.lsKey),
          swal(
            "",
            "Random render is now " + (r ? "disabled" : "enabled") + ".",
            "success",
            {
              buttons: !1,
              timer: 1500,
            }
          ),
          render.do());
      }
    });
}),
  (render.parseVersion = function () {
    var e = document.querySelector("#renderScript");
    return e && e.dataset.version ? "?v=" + e.dataset.version : "";
  }),
  (render.do = function (e) {
    if (
      (render.done || (render.done = !0),
      (render.config = render.configs[render.type]),
      render.config && render.config.array.length)
    ) {
      var n = document.querySelector("body > .render");
      n && n.remove();
      var r;
      e || "0" !== localStorage[render.lsKey]
        ? (void 0 === render.version &&
            (render.version = render.parseVersion()),
          (render.selected =
            render.config.array[
              Math.floor(Math.random() * render.config.array.length)
            ]),
          ((r = document.createElement("img")).alt = r.title =
            render.config.name),
          (r.className = "is-hidden-mobile"),
          (r.src = "" + render.config.root + render.selected + render.version))
        : (((r = document.createElement("a")).className =
            "button is-info is-hidden-mobile"),
          (r.title = render.config.name),
          (r.innerHTML = '<i class="icon-picture"></i>')),
        r.classList.add("render"),
        r.addEventListener("click", render.showTogglePrompt),
        document.body.appendChild(r);
    }
  }),
  (render.onloaded = function () {
    "undefined" != typeof page &&
      page.apiChecked &&
      !render.done &&
      render.do();
  }),
  "interactive" === document.readyState || "complete" === document.readyState
    ? render.onloaded()
    : window.addEventListener("DOMContentLoaded", function () {
        return render.onloaded();
      });
//# sourceMappingURL=render.js.map
