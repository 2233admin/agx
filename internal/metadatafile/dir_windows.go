//go:build windows

package metadatafile

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// Dir is a directory handle opened without following a reparse point at its
// own final path component. Windows has no dirfd-relative openat equivalent
// exposed via golang.org/x/sys/windows, so every subsequent operation on an
// entry within it re-derives the directory's current canonical path from the
// held handle itself (GetFinalPathNameByHandle, not a fresh walk from the
// original path string) and opens the entry with FILE_FLAG_OPEN_REPARSE_POINT,
// which never transparently follows a reparse point: a swap is detected via
// the returned handle's own attributes, not silently redirected into. This
// narrows the race to the single Windows API call that resolves the final
// path component, rather than the caller's entire multi-step read/write
// sequence.
type Dir struct {
	f *os.File
}

// OpenDir opens path as a directory, refusing to follow a reparse point at
// path's final component.
func OpenDir(path string) (*Dir, error) {
	h, info, err := openNoFollow(path, windows.GENERIC_READ, windows.OPEN_EXISTING)
	if err != nil {
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		windows.CloseHandle(h)
		return nil, &os.PathError{Op: "OpenDir", Path: path, Err: fmt.Errorf("not a directory")}
	}
	return &Dir{f: os.NewFile(uintptr(h), path)}, nil
}

// OpenChild opens name — a single path component, not a path — as a
// subdirectory of d, refusing to follow a reparse point at name.
func (d *Dir) OpenChild(name string) (*Dir, error) {
	target, err := d.childPath(name)
	if err != nil {
		return nil, err
	}
	h, info, err := openNoFollow(target, windows.GENERIC_READ, windows.OPEN_EXISTING)
	if err != nil {
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		windows.CloseHandle(h)
		return nil, &os.PathError{Op: "OpenChild", Path: target, Err: fmt.Errorf("not a directory")}
	}
	return &Dir{f: os.NewFile(uintptr(h), target)}, nil
}

// OpenFile opens name — a single path component — within d with the given
// flags, refusing to follow a reparse point at name.
func (d *Dir) OpenFile(name string, flag int, _ os.FileMode) (*os.File, error) {
	target, err := d.childPath(name)
	if err != nil {
		return nil, err
	}
	access, createDisposition := translateFlag(flag)
	h, info, err := openNoFollow(target, access, createDisposition)
	if err != nil {
		return nil, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		windows.CloseHandle(h)
		return nil, &os.PathError{Op: "OpenFile", Path: target, Err: fmt.Errorf("is a directory")}
	}
	return os.NewFile(uintptr(h), target), nil
}

// Lstat describes name — a single path component — within d without
// following a final reparse point. Unlike OpenFile/OpenChild, this never
// fails merely because name is a reparse point: the returned FileInfo
// describes the reparse point itself.
func (d *Dir) Lstat(name string) (os.FileInfo, error) {
	target, err := d.childPath(name)
	if err != nil {
		return nil, err
	}
	h, _, err := openNoFollowRaw(target, windows.FILE_READ_ATTRIBUTES, windows.OPEN_EXISTING, true)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(h), target)
	defer func() { _ = file.Close() }()
	return file.Stat()
}

// Stat describes d itself, using d's own handle.
func (d *Dir) Stat() (os.FileInfo, error) {
	return d.f.Stat()
}

// MkdirAll ensures name — a single path component — exists as a directory
// within d.
func (d *Dir) MkdirAll(name string, _ os.FileMode) error {
	target, err := d.childPath(name)
	if err != nil {
		return err
	}
	pathPtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	if err := windows.CreateDirectory(pathPtr, nil); err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return &os.PathError{Op: "CreateDirectory", Path: target, Err: err}
	}
	return nil
}

// Rename renames oldname to newname, both single path components within d.
func (d *Dir) Rename(oldname, newname string) error {
	oldTarget, err := d.childPath(oldname)
	if err != nil {
		return err
	}
	newTarget, err := d.childPath(newname)
	if err != nil {
		return err
	}
	oldPtr, err := windows.UTF16PtrFromString(oldTarget)
	if err != nil {
		return err
	}
	newPtr, err := windows.UTF16PtrFromString(newTarget)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(oldPtr, newPtr, windows.MOVEFILE_REPLACE_EXISTING); err != nil {
		return &os.LinkError{Op: "MoveFileEx", Old: oldTarget, New: newTarget, Err: err}
	}
	return nil
}

// Link creates newname as a hard link to oldname, both single path
// components within d. Unlike Rename, this fails if newname already exists —
// callers rely on that to implement create-only semantics.
func (d *Dir) Link(oldname, newname string) error {
	oldTarget, err := d.childPath(oldname)
	if err != nil {
		return err
	}
	newTarget, err := d.childPath(newname)
	if err != nil {
		return err
	}
	oldPtr, err := windows.UTF16PtrFromString(oldTarget)
	if err != nil {
		return err
	}
	newPtr, err := windows.UTF16PtrFromString(newTarget)
	if err != nil {
		return err
	}
	if err := windows.CreateHardLink(newPtr, oldPtr, 0); err != nil {
		return &os.LinkError{Op: "CreateHardLink", Old: oldTarget, New: newTarget, Err: err}
	}
	return nil
}

// Remove removes name — a single path component — within d.
func (d *Dir) Remove(name string) error {
	target, err := d.childPath(name)
	if err != nil {
		return err
	}
	pathPtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	if err := windows.DeleteFile(pathPtr); err != nil {
		return &os.PathError{Op: "DeleteFile", Path: target, Err: err}
	}
	return nil
}

// Name returns the display path this Dir was opened with, for error
// messages only — it is never re-resolved.
func (d *Dir) Name() string {
	return d.f.Name()
}

// Close closes the directory handle.
func (d *Dir) Close() error {
	return d.f.Close()
}

// childPath re-derives d's current canonical path from its own held handle
// (not from the original path string d was opened with) and joins name onto
// it. This is what keeps a subsequent open of name race-narrow: the
// directory portion of the path is read straight from the OS's view of the
// still-open handle, not from a value that could have gone stale.
func (d *Dir) childPath(name string) (string, error) {
	canonical, err := getFinalPath(windows.Handle(d.f.Fd()))
	if err != nil {
		return "", &os.PathError{Op: "GetFinalPathNameByHandle", Path: d.f.Name(), Err: err}
	}
	return filepath.Join(canonical, name), nil
}

func getFinalPath(h windows.Handle) (string, error) {
	buf := make([]uint16, 300)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			return windows.UTF16ToString(buf[:n]), nil
		}
		buf = make([]uint16, n+1)
	}
}

// openNoFollow opens path with FILE_FLAG_OPEN_REPARSE_POINT, which never
// transparently follows a reparse point at path's final component, then
// reports the opened handle's own attributes so the caller can reject a
// reparse point (or a wrong entry type) after the fact rather than being
// silently redirected during the open itself.
func openNoFollow(path string, access, createDisposition uint32) (windows.Handle, windows.ByHandleFileInformation, error) {
	return openNoFollowRaw(path, access, createDisposition, false)
}

// openNoFollowRaw is openNoFollow with control over whether a reparse point
// at path is rejected. Lstat passes allowReparsePoint=true: like the
// standard library's os.Lstat, describing an entry must not fail just
// because it is a symlink/reparse point — only opening it for real use
// (openNoFollow's normal callers) should refuse that.
func openNoFollowRaw(path string, access, createDisposition uint32, allowReparsePoint bool) (windows.Handle, windows.ByHandleFileInformation, error) {
	var info windows.ByHandleFileInformation
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, info, err
	}
	attrs := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT | windows.FILE_FLAG_BACKUP_SEMANTICS)
	h, err := windows.CreateFile(pathPtr, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, createDisposition, attrs, 0)
	if err != nil {
		return 0, info, &os.PathError{Op: "CreateFile", Path: path, Err: err}
	}
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		windows.CloseHandle(h)
		return 0, info, &os.PathError{Op: "GetFileInformationByHandle", Path: path, Err: err}
	}
	if !allowReparsePoint && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		windows.CloseHandle(h)
		return 0, info, &os.PathError{Op: "CreateFile", Path: path, Err: fmt.Errorf("refusing to follow reparse point: %w", ErrUnsafeEntry)}
	}
	return h, info, nil
}

// translateFlag maps the small subset of os.O_* combinations this package
// actually uses onto Win32 CreateFile access rights and creation
// disposition. It is deliberately not a general-purpose translator.
func translateFlag(flag int) (access, createDisposition uint32) {
	switch {
	case flag&os.O_RDWR != 0:
		access = windows.GENERIC_READ | windows.GENERIC_WRITE
	case flag&os.O_WRONLY != 0:
		access = windows.GENERIC_WRITE
	default:
		access = windows.GENERIC_READ
	}
	switch {
	case flag&os.O_CREATE != 0 && flag&os.O_EXCL != 0:
		createDisposition = windows.CREATE_NEW
	case flag&os.O_CREATE != 0 && flag&os.O_TRUNC != 0:
		createDisposition = windows.CREATE_ALWAYS
	case flag&os.O_CREATE != 0:
		createDisposition = windows.OPEN_ALWAYS
	case flag&os.O_TRUNC != 0:
		createDisposition = windows.TRUNCATE_EXISTING
	default:
		createDisposition = windows.OPEN_EXISTING
	}
	return access, createDisposition
}
