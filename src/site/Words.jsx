import React, { Children, cloneElement, isValidElement } from "react";

/** Splits a heading's text into masked words that rise in one after another when it scrolls into view. */
export function Words({ as: Tag = "h2", children, ...props }) {
  let n = 0;
  const split = (node) =>
    Children.map(node, (child) => {
      if (typeof child === "string") {
        return child.split(/(\s+)/).map((part, i) =>
          !part ? null : /^\s+$/.test(part) ? (
            part
          ) : (
            <span className="word" key={i}>
              <span style={{ "--w": n++ }}>{part}</span>
            </span>
          ),
        );
      }
      if (isValidElement(child) && child.type !== "br" && child.props.children != null) {
        return cloneElement(child, undefined, split(child.props.children));
      }
      return child;
    });
  return (
    <Tag data-reveal="words" {...props}>
      {split(children)}
    </Tag>
  );
}
