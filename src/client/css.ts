/**
 * Installs one of this plugin's stylesheets.
 * @module dsh-buddy/client/css
 */

/**
 * Add a stylesheet to `document.head`, marked the way host plugins mark theirs.
 * @param doc - the document, or `undefined` outside a browser.
 * @param id - the `data-plugin-css` marker.
 * @param css - the rules.
 * @returns a disposer that removes exactly the tag this call added.
 */
export function installCss(doc: Document | undefined, id: string, css: string): () => void {
	if (doc === undefined) return () => {};
	const tag = doc.createElement("style");
	tag.dataset["plugin"] = "dsh-buddy";
	tag.dataset["pluginCss"] = id;
	tag.textContent = css;
	doc.head.appendChild(tag);
	return () => tag.remove();
}
