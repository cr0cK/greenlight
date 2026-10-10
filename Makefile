.PHONY: check pack install clean

UUID = babysitpr@cr0ck.github.io
DIST = dist
BUNDLE = $(DIST)/$(UUID).shell-extension.zip

check:
	glib-compile-schemas --strict --dry-run schemas
	node --input-type=module --check < extension.js
	node --input-type=module --check < prefs.js
	node --input-type=module --check < filters.js
	node --input-type=module --check < quickopen.js
	node --input-type=module --check < preview.js
	node --input-type=module --check < markdown.js
	node --test tests/*.test.js
	mkdir -p $(DIST)
	gnome-extensions pack --force \
		--extra-source=babysitpr-pr-symbolic.svg \
		--extra-source=filters.js \
		--extra-source=quickopen.js \
		--extra-source=preview.js \
		--extra-source=markdown.js \
		--extra-source=LICENSE \
		--out-dir $(DIST) .

pack: check

install: pack
	gnome-extensions install --force $(BUNDLE)

clean:
	rm -rf $(DIST)
