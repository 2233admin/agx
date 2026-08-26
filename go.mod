module github.com/2233admin/agx

go 1.25.0

// toolchain go1.25.13 fixes reachable stdlib CVEs (GO-2026-6218, GO-2026-6090, GO-2026-5972, GO-2026-5856, GO-2026-5026); see #105.
toolchain go1.25.13

require golang.org/x/sys v0.47.0
