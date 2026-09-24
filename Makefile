.PHONY: check pack install clean

UUID = babysitpr@alexis
DIST = dist
BUNDLE = $(DIST)/$(UUID).shell-extension.zip

check:
	glib-compile-schemas --strict --dry-run schemas
	node --input-type=module --check < extension.js
	node --input-type=module --check < prefs.js
	node --input-type=module --check < filters.js
	mkdir -p $(DIST)
	gnome-extensions pack --force \
		--extra-source=babysitpr-pr-symbolic.svg \
		--extra-source=filters.js \
		--out-dir $(DIST) .

pack: check

install: pack
	gnome-extensions install --force $(BUNDLE)

clean:
	rm -rf $(DIST)
