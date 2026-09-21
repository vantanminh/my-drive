#include <stdint.h>
#include <stdlib.h>
#include <vips/vips.h>

#define MAX_SOURCE_SIDE 40000
#define MAX_SOURCE_PIXELS UINT64_C(100000000)

static void block_unapproved_loaders(void) {
    vips_operation_block_set("VipsForeignLoad", TRUE);
    vips_operation_block_set("VipsForeignLoadJpeg", FALSE);
    vips_operation_block_set("VipsForeignLoadPng", FALSE);
    vips_operation_block_set("VipsForeignLoadWebp", FALSE);
    vips_operation_block_set("VipsForeignLoadGif", FALSE);
    vips_operation_block_set("VipsForeignLoadHeif", FALSE);
}

int main(int argc, char **argv) {
    if (argc != 4) {
        return 2;
    }

    char *end = NULL;
    long requested_side = strtol(argv[3], &end, 10);
    if (end == argv[3] || *end != '\0' || requested_side < 1 || requested_side > 1920) {
        return 2;
    }

    if (VIPS_INIT(argv[0])) {
        return 2;
    }
    vips_cache_set_max(20);
    vips_cache_set_max_mem(128 * 1024 * 1024);
    block_unapproved_loaders();

    VipsImage *input = vips_image_new_from_file(argv[1], "access", VIPS_ACCESS_SEQUENTIAL, NULL);
    if (input == NULL) {
        vips_shutdown();
        return 2;
    }

    int width = vips_image_get_width(input);
    int height = vips_image_get_height(input);
    uint64_t pixels = (uint64_t) width * (uint64_t) height;
    if (width <= 0 || height <= 0 || width > MAX_SOURCE_SIDE ||
        height > MAX_SOURCE_SIDE || pixels > MAX_SOURCE_PIXELS) {
        g_object_unref(input);
        vips_shutdown();
        return 3;
    }

    VipsImage *thumbnail = NULL;
    if (vips_thumbnail(argv[1], &thumbnail, (int) requested_side,
                       "height", (int) requested_side,
                       "size", VIPS_SIZE_DOWN,
                       NULL)) {
        g_object_unref(input);
        vips_shutdown();
        return 2;
    }
    g_object_unref(input);

    if (vips_image_get_width(thumbnail) <= 0 ||
        vips_image_get_height(thumbnail) <= 0 ||
        vips_image_get_width(thumbnail) > requested_side ||
        vips_image_get_height(thumbnail) > requested_side ||
        vips_image_write_to_file(thumbnail, argv[2], NULL)) {
        g_object_unref(thumbnail);
        vips_shutdown();
        return 2;
    }

    g_object_unref(thumbnail);
    vips_shutdown();
    return 0;
}
